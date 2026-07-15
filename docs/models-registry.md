# Model registry — how Dispatch knows the latest models & effort levels

The dropdowns in Settings / column CFG / ticket overrides / the comment composer are fed by
`registry.mjs`, which resolves **models and their per-model effort levels** through an ordered
source chain per provider. Authoritative, account-authenticated sources first; scraping only as
fallback; never an LLM's memory (it can't know models newer than its training).

## Source chains (best → worst)

| # | Claude | Codex |
|---|--------|-------|
| 1 | **Anthropic Models API** — `GET api.anthropic.com/v1/models`, authenticated with Claude Code's readable OAuth token (`CLAUDE_CODE_OAUTH_TOKEN` or `~/.claude/.credentials.json`, `anthropic-beta: oauth-2025-04-20`). Returns the live model list **with a `capabilities.effort` object per model** → exact supported effort levels. | **`codex app-server` JSON-RPC `model/list`** — the ChatGPT-authed picker list. Returns per-model `supportedReasoningEfforts` **and `defaultReasoningEffort`**, and reflects what *this account* can actually run. |
| 2 | Docs scrape: `platform.claude.com` models overview (models only, regex-parsed, junk-filtered) | Docs scrape: `developers.openai.com/codex/models` |
| 3 | Last successful cache (`~/dispatch-data/models-cache.json`, versioned) | same |
| 4 | Built-in seed (4 curated models per provider) | same |

A chain stops at the first source that succeeds. Failures are recorded per source and surfaced in
the refresh report/toast (`claude: unreachable (kept cache)`).

## Semantics worth knowing

- **Authoritative replace, not union.** When source #1 succeeds, its list *replaces* the provider's
  models — it is the truth for what the account can run. (This is why `gpt-5.6-*` from the docs
  don't appear: the ChatGPT plan can't run them; the old scrape-union happily advertised models
  that would fail at runtime.)
- **In-use models never vanish.** Any model referenced by a column config or ticket override
  survives a refresh even if the provider retired it — kept and labeled `(retired)` — so existing
  configurations never silently lose their selection.
- **Per-model efforts.** `efforts: [...]` on a model filters the effort dropdown next to it.
  `efforts: []` means the model takes no effort parameter (e.g. Haiku 4.5) → dropdown shows only
  "default". `efforts: null/absent` (docs/seed sources) → falls back to the harness-type list.
  Codex models also carry `defaultEffort`, marked "· model default" in the dropdown.
- **Curated labels** (`fable (Fable 5)` etc.) are re-attached by id after every refresh.

## Freshness

- **Boot:** refresh runs automatically if the cache is older than 24 h.
- **Daily:** a 24 h interval repeats it.
- **Manual:** every model dropdown has a **↻** button → `POST /api/models/refresh`.
- Settings shows per-provider `source · age` under the phase-defaults table.

## Failure modes (all tested)

| Scenario | Behavior |
|---|---|
| OAuth token expired / credentials missing / keyring-only auth | Claude falls to docs scrape |
| `codex` binary missing / app-server hangs (20 s timeout) | Codex falls to docs scrape |
| Docs pages also unreachable | Cache (or seed) retained, `ok:false` + per-source errors reported |
| Cache schema changes | `CACHE_VERSION` mismatch → cache ignored, next refresh rebuilds it |

## Adding a provider

Add a seed block to `SEED`/`REGISTRY`, write a `fetchXxxModels()` returning
`[{ id, label, efforts|null, defaultEffort|null }]`, and register it in the `chains` table inside
`refreshModels()`. Everything downstream (cache, UI dropdowns, effort filtering, ↻) is generic.

## Tests

`npm test` → `test/registry.test.mjs` (node:test, no deps): docs-parser junk rejection
(truncated slugs, bedrock variants, image filenames), capabilities→efforts mapping,
authoritative-replace semantics, in-use survival marking.

## Security note

The Claude OAuth token is read fresh from `CLAUDE_CODE_OAUTH_TOKEN` or disk per refresh,
sent only to `api.anthropic.com`, and never logged or cached in memory. Modern Claude Code
may keep auth material only in the CLI/keyring; that still authenticates agent runs, but
model and usage enrichment degrade to fallback data unless a readable OAuth token is
available. If Anthropic ever scopes the token away from `/v1/models`, the chain degrades
to the docs scrape automatically.
