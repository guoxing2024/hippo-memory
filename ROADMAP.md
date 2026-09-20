# Roadmap

Open, living plan — ordered by expected user impact. PRs welcome on any item.

## v0.2.x — recall quality & trust

- [x] **二轮审计落地（2026-09-20）**：嵌入默认 `auto`（语义召回成为默认，`off` 为退出项）；`verifyAttested` 信任分级（`[VERIFIED]` vs `[VERIFIED self-reported]`，护盾只保护可复核证据）；`sourceMonitor.contested` 三态裁决；`summarizer` LLM 巩固钩子（模板为回退）；`forget` 零召回保护（`forgetGraceSec` + 证据豁免，打断"召不回→被遗忘"负反馈环）；`recall({ scope })` 前提硬过滤（`scopeExcluded`）；bench 增加朴素 RAG 对照臂（RAG 编造率 63% vs hippo 25%，量化版本化纠正链的增量）。
- [ ] **真实 LLM 端到端基准**：现有 bench 的答题臂是字符串匹配模拟器（检索臂模拟，n=8）。需要一个真模型跑 LongMemEval 式任务 + 朴素 RAG 对照，产出可引用的幻觉率数字。
- [x] Explicit correction edges + write-time neighbour echo (`supersedes` / `superseded_by`, `neighbours[]`)
- [x] Observability: `diagnostics()` / `health` / `override-audit` / `memory_maintain status`
- [x] Evidence, retraction and prospective guards (verify_* + TTL, `retracts`, `guard`)
- [x] Injection guard on every engine output path + `[memory data]` frame (adapter-side coverage is the open item below)
- [x] Two-gate overrides (content + claim cosine) so a bad override degrades to a new row
- [x] **`memory_maintain duplicates` gains a `merge` action** — engine `mergeDuplicates({ ids, into?, dryRun? })`, exposed as `merge` in both adapters (preview by default, `dry_run: false` applies). A confirmed group folds into one live trace: extras are **demoted into** the survivor (same mechanism as `compress`, so `undemote` restores them and nothing reaches `memory_history`-then-delete), and the survivor first inherits the union of entities/tags plus the richest `detail` and highest `importance`. Refuses three things: rows whose premise disagrees with the survivor (returned in `blocked[]` naming the clashing key — `duplicates()` now reports per-row `scope` and a group-level `mixedPremises`), ids that are not restatements of one claim, and marker rows (`retraction` / `guard` / `invariant`). opencode gained the missing `undemote` action so the reversibility the note promises is actually reachable there.
- [x] **Digest never renders a bare top-1 as fact** — when nothing clears the floor, `composeContext` now shows the single closest trace as line 1 marked `[low-confidence sim 0.31 < floor 0.32: the closest trace, not a memory — verify before asserting]`, with `items[0].lowConfidence` for programmatic checks and a warning naming the standing. A guess never borrows `[VERIFIED]` / `[ASSERTED]` from its row. No guess at all when similarity is 0 or the store is empty; `{ lowConfidenceTop1: false }` opts out. The `[recent]` backfill on zero hits was withdrawn (it made the channel look healthy while serving the last writes) — this is the batch's one behaviour-contract change. Miss counter: `diagnostics().coverage = { turns, misses, guesses, scope: 'process' }`, deliberately not persisted.
- [x] **`status` reports `sibling_stores` and the effective scope rule** — engine exports `surveyStores(dir, { current })` (row/demoted counts and mtime per `.db` beside this one, `current` flagged, unopenable files listed in `unreadable[]` instead of losing the report) and `SCOPE_RULE` (the "memories never cross store files" contract, written once). `diagnostics()` carries both plus `suspicious.emptyWhileSiblingsFull`; each adapter adds a host-specific `path_rule` (per-agent-id vs per-project-directory) and its `health` verdict now checks the store split before the embedder mismatch. `:memory:` stores skip the directory survey.
- [ ] **Sanitize every opencode tool result**: the digest is engine-sanitized and the new `duplicates` / `merge` reports are too, but `list`, `history` and `recall` hits still hand stored text to the model verbatim (DSH cleans all of these).
- [ ] **GUI memory browser**: per-store inventory / search / delete in the settings card — requires a clean host→browser channel (investigate `dsh-api-remotes` custom contribution vs settings-section snapshot)
- [ ] Adapter regression tests for the embedding toggle path (mock model, verify stores rebuild on settings change)
- [ ] Export/import a store as JSON (backup + migration)
- [ ] `memory_maintain history` output rendered as a readable version diff

## v0.2.x — other hosts

- [x] **Engine runs on Bun** (core 0.2.1): runtime driver detection (`node:sqlite` / `bun:sqlite`) + lazy loading, so the package imports and runs inside Bun hosts such as opencode — verified end-to-end on opencode 1.18.31 / Bun 1.3.14
- [x] **`opencode-hippo-memory`** (in this repo under `packages/`): opencode plugin packaging the 4 memory tools (via `tool()`), digest injection (`experimental.chat.system.transform` with a `messages.transform` fallback that is guarded against double injection), pre-compaction carry-over (`experimental.session.compacting`), usage discipline and options (`enabled` / `contextLimit` / `sharedStore` / `discipline` / `similarityThreshold`); per-project stores under the platform cache root (Windows: `%LOCALAPPDATA%\opencode\hippo-memory`). Published to npm (0.2.2) and verified as installed by opencode's own registry pipeline: `~/.cache/opencode/packages/<spec>/node_modules/opencode-hippo-memory` resolves `main` -> `lib/index.js`, `@opencode-ai/plugin@1.18.31` present in the plugin's own tree, default export is a function, 6 hooks returned, tools carry real zod schemas, remember/recall round-trip writes a per-project `.db`
- [x] Adapter tests driving the plugin object directly (16 cases: tools, injection, idempotency, compaction carry-over, options, error containment, scope / OUT_OF_SCOPE, duplicates → merge → undemote, status split verdict)

## v0.3.x — semantic memory

- [x] **`scope` field (premises, not namespaces)** — improvement proposal P0-1b. A memory can now state the conditions it holds under (`population=… ; comparator=… ; release=…`), compared structurally with **no new similarity threshold** (`diagnostics().thresholds` unchanged): only keys both sides name, values compatible when one contains the other or Jaccard ≥ 0.5. A write whose premise disagrees with the nearest incumbent is kept as its own trace (`different-scope:` warning) instead of overriding it; `sourceMonitor(claim, { scope })` prefers the trace stated under the caller's premises, answers `out_of_scope` on a disagreement, and appends a `CONDITIONAL SCOPE` note when the support's premise was never checked. `scope` renders as `[scope: …]` in composed context and is surfaced by `recall` / `neighbours` / `history`. Old stores gain the column through `ensureColumns()` — no migration step.
- [ ] **`scope` as a namespace** (project / repo / session group) with hard filtering on the read path: today `scope` carries *premises* and is used by the write gates, verify and ranking only — store-level isolation is still `sharedStore` plus one file per session/project.
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
