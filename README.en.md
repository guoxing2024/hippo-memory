# 🧠 HippoMemory (English)

> English summary. Full docs: [中文使用说明](docs/USER-GUIDE.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md)

**Hippocampus-inspired long-term memory for AI agents.** Fights the classic failure mode of long sessions: context overflow → forgotten facts → hallucination.

```
plain long context (no memory):   0/8  correct, 25% confabulation
HippoMemory-backed:               8/8  correct, 0% confabulation
```
*(bench/anti-hallucination-bench.mjs, 60 noise turns)*

## Packages

| Package | What | Install |
|---|---|---|
| **dsh-hippo-memory** | DSH plugin — memory tools, automatic digest injection, usage guidance, GUI settings card | `dsh plugin --profile web add dsh-hippo-memory` |
| **hippo-memory-core** | Framework-agnostic engine (use in any agent loop) | `npm install hippo-memory-core` |

## Quick start (DSH)

```bash
dsh plugin --profile web add dsh-hippo-memory
dsh web
# Settings → Plugins → Plugin settings → HippoMemory (enabled by default)
```

Agents get 4 tools: `memory_remember`, `memory_recall`, `memory_verify`, `memory_maintain` — plus a per-turn `[hippo-memory digest]` that auto-injects only when relevant memories are found (~20–40 tok each, 0 when nothing matches).

## Features

- **Local-first**: SQLite via `node:sqlite`, per-session stores under `~/.dsh/storages/hippo-memory/`. No cloud, no network, no external services.
- **Conflict versioning**: correcting a stored value archives the old revision (`history`), never silently overwrites. The write call reports exactly what it replaced via `superseded: { id, version, summary }`.
- **Source monitoring**: `memory_verify` returns SUBSTANTIATED / CONTRADICTED / UNSUBSTANTIATED, with the nearest candidate (`closest`) when it can't substantiate, so “why not” is answerable. It reports a **raw cosine** (single best 1-NN, no importance weighting) — the same scale as `recall().hits[].similarity`, not `score`.
- **Explainable recall**: every hit carries three distinct numbers — `similarity` (raw cosine, comparable to the threshold and to `memory_verify`), `score` (ranking value: `similarity × (0.6 + 0.4·importance)`, capped at 1.0), and `relativeScore` (best hit for *this* query = 1.0). An empty result returns `reason` (`below-threshold` vs `no-candidates`), `eligible`, `bestSimilarity`, `threshold`, and `nearMisses` instead of a bare empty array.
- **Literal identifier matching**: an exact token hit (`0x6070`, `D-387`, a commit sha, a version) is stronger evidence than a low cosine for a bare-identifier query, so such rows are retrieved even below the threshold and flagged `literalMatch`. Measured on a real 167-memory store over 277 identifier queries: Top-1 hit rate 10.5% → **99.6%**, MRR 0.195 → **0.998**.
- **Duplicate reporting**: `duplicates()` is a read-only report of near-duplicate restatements across kinds (ignoring the consolidation `FACT: ` wrapper). Consolidation itself no longer creates the episode/rule twin.
- **Optional real embeddings** (setting `auto`): lazy-loads `Xenova/bge-small-zh-v1.5` (~24MB quantized, cached under the store dir) for strong CJK/paraphrase recall; falls back to the built-in hashing embedder on any failure.
- **Adaptive forgetting & consolidation**: `consolidate` abstracts repeated episodes into semantic rules; `forget` decays weak traces with a dry-run preview.
- **Tidy storage**: stores open lazily — read-only traffic stays in memory, the `.db` appears only on first write, and `memory_maintain prune` sweeps empty leftovers.
- **GUI card**: enable/disable live, context limit, shared store, embedding mode, recall threshold.
- **One-shot migration**: enabling auto re-embeds legacy hash rows with the model automatically (persisted marker, runs once); `memory_maintain status` reports model state.

## Engine quick start

```js
import { HippoMemory } from 'hippo-memory-core';

const mem = new HippoMemory({ dbPath: './agent-memory.db' });
await mem.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
const { context } = await mem.composeContext('fix billing connection', { limit: 5 });
const v = await mem.sourceMonitor('billing service database is postgres');
// v.substantiated ? 'safe to assert' : 'answer: not in my memory'
```

Node ≥ 22.5 (built-in `node:sqlite`). Tests: `npm test` (28 engine + adapter). Bench: `npm run bench`.

## Roadmap & issues

[ROADMAP.md](ROADMAP.md) · [issue templates](.github/ISSUE_TEMPLATE/) · MIT license
