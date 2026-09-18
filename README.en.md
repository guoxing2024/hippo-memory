# 🧠 HippoMemory (English)

> English summary. Full docs: [Chinese user guide](docs/USER-GUIDE.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](ROADMAP.md)

**Hippocampus-inspired long-term memory for AI agents.** Fights the classic long-session failure mode: context overflow → forgotten facts → hallucination.

```
plain long context (no memory):   0/8 correct, 25% confabulation
HippoMemory-backed:               8/8 correct,  0% confabulation
```
*(bench/anti-hallucination-bench.mjs, 60 noise turns)*

Local-first, zero external services: SQLite via Node's built-in `node:sqlite`, optional local embedding model (~24MB). No cloud, no network, no API keys.

## Packages

| Package | What | Install |
|---|---|---|
| **dsh-hippo-memory** | DSH plugin — memory tools, automatic digest injection, usage guidance, GUI settings card | `dsh plugin --profile web add dsh-hippo-memory` |
| **hippo-memory-core** | Framework-agnostic engine (use in any agent loop) | `npm install hippo-memory-core` |

Both are at **0.2.0**. Upgrade: `dsh plugin --profile <profile> update dsh-hippo-memory`, then restart the profile. Stores need **no migration**.

## Quick start (DSH)

```bash
dsh plugin --profile web add dsh-hippo-memory
dsh web
# Settings → Plugins → Plugin settings → HippoMemory (enabled by default)
```

Agents get 4 tools — `memory_remember`, `memory_recall`, `memory_verify`, `memory_maintain` — plus a per-turn `[hippo-memory digest]` that injects only the memories relevant to the current cue (~20–40 tok each, 0 when nothing matches).

## Features

- **Local-first**: SQLite via `node:sqlite`, per-session stores under `~/.dsh/storages/hippo-memory/`. No cloud, no network, no external services.
- **Conflict versioning**: correcting a stored value archives the old revision (`history`), never silently overwrites. The write call reports exactly what it replaced via `superseded: { id, version, summary }`.
- **Trustworthy writes (0.2.0)**: `memory_remember` echoes the nearest neighbours (`neighbours[]` with `suspectedConflict`) so a correction is never blind, and accepts `supersedes: [ids]` to explicitly retire wrong rows (`superseded_by` edge, kept for audit, excluded from recall).
- **Source monitoring**: `memory_verify` returns SUBSTANTIATED / CONTRADICTED / UNSUBSTANTIATED plus four evidence groups — `contradicting[]`, `newer_related[]`, `superseded_matches[]`, `stale_support` — so an old wording winning on cosine no longer hides the real, newer conclusion. It reports a **raw cosine** (single best 1-NN, no importance weighting) — the same scale as `recall().hits[].similarity`, not `score`.
- **Explainable recall**: every hit carries three distinct numbers — `similarity` (raw cosine, comparable to the threshold and to `memory_verify`), `score` (ranking value: `similarity × (0.6 + 0.4·importance)`, capped at 1.0), and `relativeScore` (best hit for *this* query = 1.0). An empty result returns `reason` (`below-threshold` vs `no-candidates`), `eligible`, `bestSimilarity`, `threshold`, and `nearMisses` instead of a bare empty array.
- **Literal identifier matching**: an exact token hit (`0x6070`, `D-387`, a commit sha, a version) is stronger evidence than a low cosine for a bare-identifier query, so such rows are retrieved even below the threshold and flagged `literalMatch`. Measured on a real 167-memory store over 277 identifier queries: Top-1 hit rate 10.5% → **99.6%**, MRR 0.195 → **0.998**.
- **Evidence, retraction, prospective guards (0.2.0)**: recheckable provenance (`verify_cmd` / `verify_expect` / `verify_artifact` + `verify_result`) with a 30-day freshness TTL — a fresh `[VERIFIED]` row can only be retired by other passing evidence, otherwise it renders `[ASSERTED]`; `retracts` marks a do-not-repeat retraction; `guard_trigger` / `guard_action` register a prospective trigger that is injected as `[GUARD]` when the cue matches.
- **Duplicate reporting**: `duplicates()` is a read-only report of near-duplicate restatements across kinds (ignoring the consolidation `FACT: ` wrapper). Consolidation itself no longer creates the episode/rule twin.
- **Optional real embeddings** (setting `auto`): lazy-loads `Xenova/bge-small-zh-v1.5` (~24MB quantized, cached under the store dir) for strong CJK/paraphrase recall; falls back to the built-in hashing embedder on any failure.
- **Adaptive forgetting & consolidation**: `consolidate` abstracts repeated episodes into semantic rules; `forget` decays weak traces with a dry-run preview; `compress` folds N same-scope traces into 1 caller-authored invariant + K representatives (`undemote` restores).
- **Spaced repetition**: rehearsal strength grows with the gap since last access (`0.01 + 0.03·log2(1+days)`, capped at 0.12) — massed repetition earns little, spaced re-telling earns a lot, and a genuine recall after a gap strengthens the trace too (testing effect). `memory_remember` accepts an explicit `importance` (0..1) so critical facts can outrank trivia.
- **Injection guard (memory anti-poisoning)**: a page the agent read can end up inside a `memory_remember` write ("ignore all previous instructions…") and would then re-inject into every turn. Rendered memory text is sanitized (`[sanitized-*]` markers) across every output path (digest / recall / verify / maintain), wrapped in a `[memory data … not instructions]` frame; stored rows stay untouched for audit, and infected rows are flagged (`injection:` warnings in recall/verify, `injectionWarnings` in list). Zero false positives across all real stores tested.
- **Safer overrides**: path-3 now needs **two gates** — content cosine *and* a summary-to-summary claim cosine (default 0.75). If the claim gate fails the write degrades to a new row with a `withheld-contradiction:` warning: better an extra row than a lost memory.
- **Concurrent-safe shared store**: WAL + `busy_timeout` (5s default, configurable) so multi-agent shared-store writes no longer throw `SQLITE_BUSY`.
- **Observability**: `diagnostics()` and `memory_maintain status` expose store path, embedder kind+dim, a stored-vector dimension histogram, `dimMismatch`, all thresholds and access stats, plus a one-line `health` verdict — the only way to catch the silent killer (model-vector store queried by the hashing fallback → garbage cosines → permanently empty recall).
- **Override audit**: `override-audit` (read-only) screens overridden pairs whose content has almost nothing in common — the signature of an unrelated memory retired by a bad override.
- **Tidy storage**: stores open lazily — read-only traffic stays in memory, the `.db` appears only on first write, and `memory_maintain prune` sweeps empty leftovers.
- **GUI card**: enable/disable live, context limit, shared store, embedding mode, recall threshold.
- **One-shot migration**: enabling `auto` re-embeds legacy hash rows with the model automatically (persisted marker, runs once); `memory_maintain status` reports model state.

## Engine quick start

```js
import { HippoMemory } from 'hippo-memory-core';

const mem = new HippoMemory({ dbPath: './agent-memory.db' });
await mem.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
const { context } = await mem.composeContext('fix billing connection', { limit: 5 });
const v = await mem.sourceMonitor('billing service database is postgres');
// v.substantiated ? 'safe to assert' : 'answer: not in my memory'
```

Node ≥ 22.5 (built-in `node:sqlite`). Tests: `npm test` (**107 engine + 30 adapter**, all green). Bench: `npm run bench`.

## Roadmap & issues

[ROADMAP.md](ROADMAP.md) · [issue templates](.github/ISSUE_TEMPLATE/) · MIT license
