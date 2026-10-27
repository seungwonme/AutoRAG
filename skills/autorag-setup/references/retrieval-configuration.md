# Retrieval configuration

## Contents

- [Retrieval defaults](#retrieval-defaults)
- [Jev routing and question decomposition (on by default)](#jev-routing-and-question-decomposition-on-by-default)
- [Retrieval and ingest caps](#retrieval-and-ingest-caps)
- [Refresh safety limits](#refresh-safety-limits)

### Retrieval defaults

MinSync and Jikji are enabled by default. Leave them enabled unless the
user explicitly asks otherwise. Indexing never happens while answering: a
question only reads indexes that `autorag refresh` (or `autorag watch`) built,
so run a refresh after setup and whenever documents change. A never-refreshed
workspace still answers, but without MinSync/Jikji evidence.

Refresh (never a query) auto-installs the binaries: MinSync installs a verified
GitHub release into `<workspace>/.autorag/bin` (`minSync.autoInstall` defaults
to true), and Jikji installs `jikji-cli` through cargo (`jikji.autoInstall`
defaults to true; requires the Rust toolchain). Set `"autoInstall": false` only
when managing the binary yourself. Refresh is incremental: MinSync syncs only
changed parsed mirrors, and `jikji prepare` reuses unchanged documents. Jikji
roots prepare one at a time (they share one central SQLite file that rejects
concurrent writers). A search root nested inside, or duplicating, another root
is skipped for Jikji because the outer root's index already covers it.

Jikji keeps its prepared corpus (search index, parsed text, wiki, routes) in one
central store, not inside your documents: `<OS data dir>/jikji/index.sqlite`
plus `<OS data dir>/jikji/roots/<id>/` (macOS `~/Library/Application Support`,
Linux `$XDG_DATA_HOME` or `~/.local/share`, Windows `%LOCALAPPDATA%`; override
with the `JIKJI_DATA_DIR` environment variable). The only file `refresh` adds
inside an approved document root is the `.jikji_agent_map.md` guide. Tell the
user that before the first `refresh`, and never delete or edit Jikji's central
store by hand; removing it only forces a full Jikji re-prepare on the next
refresh. Older Jikji versions wrote a `<root>/.jikji` directory instead; such a
leftover is now unused and safe for the user to delete.

Exact duplicate exclusion is enabled by default. AutoRAG invokes the external
`dupey` CLI before parsed-mirror indexing, keeps the newest filesystem copy for
each exact canonical-text hash, and excludes older copies from the mirror.
Install dupey during setup when it is missing (`command -v dupey || cargo
install dupey --locked`) and tell the user the feature is available; when installation
is impossible, refresh continues without this optimization and the user is
told duplicate exclusion is off. Set `"excludeExactDuplicates": false` to
index every copy.

AutoRAG owns no embedding model. MinSync provisions the embedder
(`Qwen/Qwen3-Embedding-0.6B`, 1024 dimensions) in its own cache
(`~/.cache/minsync/models`); there is no local model download and no bundled
runtime. One shared embedder serves everything that embeds inside
AutoRAG: MinSync indexing/query, memory similar-question search, the
chat-crawler sidecars, the GitHub Gist vector index, and the endpoint external
CLIs are pointed at. The default needs no embedder flags and no API key. It
resolves in order:

1. A configured remote endpoint (`minSync.embedder`), used for everything; no
   daemon is started and no local model is loaded.
2. A running `minsync serve` daemon (loopback only; MinSync 0.4.12+).
   AutoRAG never starts it: run `minsync serve --idle-timeout 0` yourself, as
   a launchd/systemd service (see `docs/minsync-setup.md`), or press
   Ctrl+Shift+E in `autorag tui`. `autorag setup` only reports whether it is
   alive.
3. MinSync's in-process engine, through the optional Node-API addon
   `@nomadamas/minsync-native` (same engine and weights, so bit-for-bit
   identical vectors; not bundled). Without a daemon and without the addon,
   embedding fails with an error naming the missing package.

Override the embedder only when intentionally using a remote provider:

```bash
autorag init \
  --embedder-id "voyageai/voyage-4-lite" \
  --embedder-base-url "https://openrouter.ai/api/v1" \
  --embedder-api-key-env "OPENROUTER_API_KEY" \
  --embedder-dimension 1024 \
  --embedder-batch-size 64
```

A remote `minSync.embedder` names an `id` (`openai:<model>`, `tei:<model>`, or
any id together with a `baseUrl`) plus optional `apiKeyEnv` (the **name** of the
environment variable holding the bearer token), `dimension`, `batchSize`, and
`timeoutMs`. OpenAI-protocol endpoints POST `{baseUrl}/v1/embeddings`; a `tei:`
endpoint POSTs `{baseUrl}/embed`; `openai:` with no `baseUrl` means
`https://api.openai.com`. Only store the environment-variable name, never its
value. `dimension` and `batchSize` must be positive integers, and `dimension`
must match the endpoint (the local default is 1024).

### Jev routing and question decomposition (on by default)

Leave both enabled. They are the recommended setup: they make simple questions
fast and multi-part questions thorough.

- **Jev** (`jev`, default `{ "backend": "dazzi" }` when signed in to Dazzi
  Models, else `{ "backend": "openrouter" }`; model `jev-1.13` on Dazzi,
  `typesafe/jev-1.13` on OpenRouter) runs before the fast answer. It routes each question to
  local search (everything needing more information),
  `organize` (moving, renaming, converting, or
  sorting files and folders), `extra` (a knowledge answer, or any other action that needs no
  retrieval, such as committing code: one turn with every tool), or the `config`
  branch, and decides
  whether to decompose it. A non-local branch only wins above a 0.75 confidence
  floor; anything weaker stays on local search. On
  local search it also decides, per registered datasource, whether to search
  it before the fast answer, using each datasource's `description` and where
  similar past questions were answered (retrieval memory). When setting up a
  datasource, always write a `description` from what it actually holds:
  channels or rooms, people, topics, time range (for example `"Team Slack,
  2024-2026: #release and #on-call channels, dependabot notifications"`).
  Jev is told descriptions are short, non-exhaustive summaries, so list the
  main content and do not try to list everything. After the fast answer it
  decides whether verification is needed, so a complete, evidence-backed fast
  answer ends the run.
- **Question decomposition** (`queryDecomposition`, default model
  `dazzi/openai/gpt-6-luna` when signed in to Dazzi Models, else
  `openrouter/qwen/qwen3.7-flash`) splits a multi-part question into at most
  five search queries that run in parallel.

Both need a credential for the chosen backend: a Dazzi Models `/login` (check with
`autorag models list --provider dazzi --available`), or the user's
`OPENROUTER_API_KEY` (`test -n "$OPENROUTER_API_KEY"`, never print it). Tell the
user Jev routing is on. Without a credential, routing falls back to a single
local search and the run always verifies, so searches still work. A
`query-route-fallback` diagnostic (`autorag search --debug`) shows that state.

```json
{
  "jev": { "backend": "openrouter" },
  "queryDecomposition": { "model": { "provider": "openrouter", "id": "qwen/qwen3.7-flash" } }
}
```

`autorag init` writes these defaults into new configs. To change them:

- Jev backend: `"backend": "typesafe"` (`TYPESAFE_API_KEY`) or `"vercel"`
  (`AI_GATEWAY_API_KEY`).
- Decomposition model: any catalog `provider`/`id`, with the same fields as
  the top-level `model`.
- `"queryDecomposition": false` decomposes with the search model itself.
- `"jev": false` turns routing off entirely. Do this only when the user
  explicitly opts out, for example because questions must never leave the
  machine (Jev and decomposition send the question text to OpenRouter).

When a user asks the running agent itself to change its settings (switch the
default model, add a provider, check that a provider works), Jev's `config`
branch loads this whole skill into that turn. The agent edits only the active
config file (and `models.json` for a custom provider), verifies with
`autorag health --json` and `autorag models list --available`, and reports each
change as old → new in its final message. It never prints a
credential value and never uses `init --force`.

### Retrieval and ingest caps

`limits` bounds retrieval, baseline prefetch, and the candidate lists handed to
the model. Every field is optional — an omitted field keeps the shipped default,
so add the section only to tighten or widen a specific cap. Values must be
positive integers; unknown keys (and unknown `prefetch` keys) fail config
resolution.

| Field | Default | Controls |
|---|---|---|
| `mergedEvidenceCeiling` | 500 | `search_all_documents` / model-free merge ceiling when the model omits `topK` |
| `singleDatasourceTopK` | 50 | `search_datasource_*` merge default when the model omits `topK` |
| `minSyncTopK` | 50 | MinSync semantic default `topK` |
| `minSyncScopedQueryTopK` | 100 | MinSync fetch cap applied when a scope narrows the query |
| `toolDescriptionInstanceScopes` | 8 | Instance scopes listed in one datasource tool description |
| `prefetch.jikjiTopK` | 30 | Jikji find candidate count |
| `prefetch.minSyncTopK` | 100 | MinSync retrieve candidate count |
| `prefetch.jikjiPathLimit` | 100 | Max Jikji answer paths rendered into the baseline |
| `prefetch.sectionLimit` | 100 | Max results rendered per baseline section |

```json
{
  "limits": {
    "mergedEvidenceCeiling": 1000,
    "prefetch": { "jikjiTopK": 12, "sectionLimit": 30 }
  }
}
```

The baseline renders each prefetched result's full chunk content (not a
per-result excerpt) so the model can see where the hit came from. Bound baseline
size with `prefetch.sectionLimit` / `prefetch.minSyncTopK` /
`prefetch.jikjiPathLimit`, not with a per-result content truncation.

Ingest caps are trusted connector options under `datasources.<name>.connector`
and are never settable from model/tool arguments: `maxDocuments`,
`maxItemsPerFeed`, and `maxContentChars` (RSS); `maxDocuments`,
`maxContentChars`, `maxResultsPerQuery`, and `maxBytesPerFile` (Spotlight);
`maxDocuments`, `maxContentChars`, `maxBytesPerFile`, `concurrency`,
`bandwidthLimit`, and `dryRun` (cloud-drive/rclone). `maxContentChars` defaults
to 20000 for RSS and 100000 for Spotlight and cloud-drive.

### Refresh safety limits

`refresh` guards the parsed-mirror refresh against deleting a corpus because a
search root became unavailable. Every field is optional; unknown keys fail
config resolution.

| Field | Default | Controls |
|---|---|---|
| `maxDeleteRatio` | 0.3 | Largest share (0–1) of indexed documents one refresh may delete; a bigger deletion above 100 documents is suppressed (`mass-delete-suppressed`) unless the refresh is forced |
| `maxScannedEntries` | 2000000 | Directory entries examined per search root before `walk-truncated` |
| `maxDepth` | 64 | Deepest directory level walked below a root before `walk-truncated` |

A root that is missing, unlistable, or empty while it previously held documents
keeps its mirrors and reports `search-root-unavailable`; see
`docs/minsync-setup.md`.
