# Roadmap

Open, living plan — ordered by expected user impact. PRs welcome on any item.

## v0.2.x — recall quality & trust

- [x] Explicit correction edges + write-time neighbour echo (`supersedes` / `superseded_by`, `neighbours[]`)
- [x] Observability: `diagnostics()` / `health` / `override-audit` / `memory_maintain status`
- [x] Evidence, retraction and prospective guards (verify_* + TTL, `retracts`, `guard`)
- [x] Injection guard on every output path + `[memory data]` frame
- [x] Two-gate overrides (content + claim cosine) so a bad override degrades to a new row
- [ ] **GUI memory browser**: per-store inventory / search / delete in the settings card — requires a clean host→browser channel (investigate `dsh-api-remotes` custom contribution vs settings-section snapshot)
- [ ] Adapter regression tests for the embedding toggle path (mock model, verify stores rebuild on settings change)
- [ ] Export/import a store as JSON (backup + migration)
- [ ] `memory_maintain history` output rendered as a readable version diff

## v0.2.x — other hosts

- [x] **Engine runs on Bun** (core 0.2.1): runtime driver detection (`node:sqlite` / `bun:sqlite`) + lazy loading, so the package imports and runs inside Bun hosts such as opencode — verified end-to-end on opencode 1.18.31 / Bun 1.3.14
- [x] **`opencode-hippo-memory`** (in this repo under `packages/`): opencode plugin packaging the 4 memory tools (via `tool()`), digest injection (`experimental.chat.system.transform` with a `messages.transform` fallback that is guarded against double injection), pre-compaction carry-over (`experimental.session.compacting`), usage discipline and options (`enabled` / `contextLimit` / `sharedStore` / `discipline` / `similarityThreshold`); per-project stores under the platform cache root (Windows: `%LOCALAPPDATA%\opencode\hippo-memory`). Published to npm (0.2.2) and verified as installed by opencode's own registry pipeline: `~/.cache/opencode/packages/<spec>/node_modules/opencode-hippo-memory` resolves `main` -> `lib/index.js`, `@opencode-ai/plugin@1.18.31` present in the plugin's own tree, default export is a function, 6 hooks returned, tools carry real zod schemas, remember/recall round-trip writes a per-project `.db`
- [x] Adapter tests driving the plugin object directly (12 cases: tools, injection, idempotency, compaction carry-over, options, error containment)

## v0.3.x — semantic memory

- [ ] `scope` field: declare an explicit scope (project / repo / session group) so conflict detection and recall filtering stop guessing from entity overlap — this makes the current heuristic a contract
- [ ] Optional real-embedding model behind a service interface (`@xenova/transformers` bge-small-zh-v1.5 already wired as `embedding: auto`) — model quantization / fallback benchmark
- [ ] LLM-assisted `consolidate()`: today's summaries are heuristic templates; let a model extract stable patterns (keeping the heuristic fallback path)
- [ ] Cross-session "project memory" namespaces (beyond the boolean shared store)
- [ ] Episodic time decay that prefers recency without deleting old versions

## v0.4.x — ecosystem

- [ ] English docs parity (the full guide is zh-CN only; README.en.md is a summary)
- [ ] Koishi-style plugin metadata for community catalogs once DSH has one
- [ ] CI publish workflow (auto `npm publish` on version tags)

## Done

- [x] 0.1.0 — engine + adapter dual package, tools/GUIDANCE/digest/GUI card, per-session SQLite stores
- [x] 0.1.1 — npm keywords/repository discoverability; public GitHub repo
- [x] 0.1.2 — explainable verify (closest), memory_maintain list, optional local embedding model (setting `embedding: auto`, lazy bge-small-zh-v1.5), configurable recall threshold, adapter test suite, GitHub CI, EN README, ROADMAP + issue templates
- [x] 0.1.3 — adapter declares transformers optionalDep so `embedding: auto` resolves after npm install
- [x] 0.1.3/0.1.4 — engine `ensureEmbeddingMigration()` (hash-to-model one-shot re-embed, persisted marker); fix transformers.js batch tensor parsing; model download/status visibility (`memory_maintain status`)
- [x] 0.1.4/0.1.6 — lazy model load (faster `dsh web` startup), digest blank fix, `memory_maintain delete`, read-path model-ready guard
- [x] 0.1.5/0.1.6 — docs sync; CHANGELOG shipped in the npm package files
- [x] core 0.1.6 / adapter 0.1.8 — recall explainability (reason/eligible/bestSimilarity/threshold/nearMisses), three score views (similarity/score/relativeScore), literal identifier matching (Top-1 10.5% → 99.6% on 277 real queries), `memory_maintain duplicates` report, `superseded` on override, FACT:-prefix merge fix, lazy store open + prune empty-store sweep
- [x] core 0.2.1 — **Bun runtime support**: driver resolved at load time (Node `node:sqlite` / Bun `bun:sqlite`) with lazy builtin loading, `sqliteDriver` + `setSqliteDriver()` exports, store auto-creates its parent directory; 140 engine tests green; verified inside opencode
- [x] **0.2.0 — the anti-hallucination release (both packages)**: correction chain (verify evidence groups + neighbour echo + explicit `supersedes` edges); evidence / retraction / prospective guards with TTL; two-gate override (content + claim cosine) after the silent-override incident and its recurrence; injection guard on every output path + `[memory data]` frame; spaced repetition (`0.01 + 0.03·log2(1+days)`) + explicit `importance`; shared-store concurrency (WAL + busy_timeout); `diagnostics()` health; `override-audit`; `compress` / `undemote` schema compression; conflict-detection trigger widening (polarity / shared-entity / claimParts channels); 107 engine + 30 adapter tests green
