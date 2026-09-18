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
| **opencode-hippo-memory** | opencode plugin — same 4 memory tools + per-turn digest, compression survives | `opencode plugin -g opencode-hippo-memory` |
| **hippo-memory-core** | Framework-agnostic engine (use in any agent loop) | `npm install hippo-memory-core` |

Adapters are at **0.2.1 (DSH) / 0.2.2 (opencode)**, engine at **0.2.1**. Engine **0.2.1** added **Bun support**: the SQLite driver is detected at load time (`node:sqlite` on Node, `bun:sqlite` on Bun), so `hippo-memory-core` imports and runs inside Bun hosts such as **opencode** (verified on opencode 1.18.31 / Bun 1.3.14: remember, recall, verify, digest and diagnostics all work — no bundling, no shims). `sqliteDriver` tells you which driver is active; `setSqliteDriver()` lets you plug your own. Upgrade: `dsh plugin --profile <profile> update dsh-hippo-memory`, then restart the profile. Stores need **no migration**.

⚠️ After installing an adapter, **restart the host and verify by side effect** (does a `.db` appear in the store directory after one turn?) rather than by config echo: `opencode debug info` only prints configuration, and a failed plugin load can leave zero log lines behind.

## 🆕 Unreleased — premise scope, duplicate merge, low-confidence fallback, sibling stores visible (version TBD)

Four changes from one piece of field feedback, all on one theme: **separating "looks like there is nothing" from "that is not what happened"**.

- **① Premise scope (`scope`)** — see the *Premise scope* bullet below.
- **② Duplicates can be merged** — `duplicates()` used to be read-only, so cleanup meant `delete`, which drops version history with it. `mergeDuplicates({ ids, into, dryRun })` (host-side: `memory_maintain merge`, in both adapters, **preview by default**) now folds the extras into a survivor: rows stay in the store, disappear from default recall, and come back with `undemote`. Entities, tags, the longer `detail` and a higher `importance` are carried over *before* the source rows retire. **The same sentence under two premises is not a duplicate**: groups now carry `mixedPremises`, which means *some pair* in the group disagrees. `merge` never folds a row whose premises clash with the survivor — those come back in `blocked[]` naming the clashing keys, while the rows that do agree are still merged; if every other row clashes, nothing is folded and `survivor` is `null`.
- **③ A below-threshold recall is no longer blank** — every hit under the floor used to render as "nothing relevant", identical in shape to an empty store. The closest trace is now surfaced as line 1 tagged `[low-confidence sim 0.31 < floor 0.32: the closest trace, not a memory — verify before asserting]`, without borrowing the row's `[VERIFIED]` / `[ASSERTED]` badge; `items[0].lowConfidence === true` covers the programmatic side. Still no guess when similarity is exactly 0, the store is empty, or `{ lowConfidenceTop1: false }` is passed. Zero-hit digests no longer backfill `[recent]` filler. `diagnostics().coverage` counts `turns / misses / guesses` for the live process.
- **④ `status` can see the other store** — DSH shards by agent id, opencode by project directory, which makes "was never stored" and "was stored in a different file" render identically. `diagnostics()` now returns `sibling_stores` (every `.db` in the directory: rows, demoted, last write, which one answered) plus `scope_rule` (the contract lives in the engine once); each adapter's `status` adds its own host `path_rule`, and `health` checks "empty here, full next door" first.

Engine + both adapters + docs are ready (**194 tests green**: 142 engine + 35 DSH + 17 opencode); **not committed, not released** — version number TBD (additive schema change). Details: [CHANGELOG.md](CHANGELOG.md).

## Quick start (DSH)

```bash
dsh plugin --profile web add dsh-hippo-memory
dsh web
# Settings → Plugins → Plugin settings → HippoMemory (enabled by default)
```

Agents get 4 tools — `memory_remember`, `memory_recall`, `memory_verify`, `memory_maintain` — plus a per-turn `[hippo-memory digest]` that injects only the memories relevant to the current cue (~20–40 tok each; 0 when the store genuinely has nothing for this cue).

## Quick start (opencode)

```bash
opencode plugin -g opencode-hippo-memory   # then restart opencode
```

Same 4 tools and the same digest. The plugin is a JS shim over the engine, so one store per **project directory** by default (or `shared.db` when configured otherwise) — which is exactly the layout `status`'s new `sibling_stores` / `path_rule` describe. Verify the install by side effect (a `.db` appearing after one turn), not by `opencode debug info`. See [packages/opencode-hippo-memory/README.md](packages/opencode-hippo-memory/README.md).

## Features

- **Local-first**: SQLite via `node:sqlite`, per-session stores under `~/.dsh/storages/hippo-memory/`. No cloud, no network, no external services.
- **Conflict versioning**: correcting a stored value archives the old revision (`history`), never silently overwrites. The write call reports exactly what it replaced via `superseded: { id, version, summary }`.
- **Trustworthy writes (0.2.0)**: `memory_remember` echoes the nearest neighbours (`neighbours[]` with `suspectedConflict`) so a correction is never blind, and accepts `supersedes: [ids]` to explicitly retire wrong rows (`superseded_by` edge, kept for audit, excluded from recall).
- **Source monitoring**: `memory_verify` returns SUBSTANTIATED / CONTRADICTED / UNSUBSTANTIATED plus four evidence groups — `contradicting[]`, `newer_related[]`, `superseded_matches[]`, `stale_support` — so an old wording winning on cosine no longer hides the real, newer conclusion. It reports a **raw cosine** (single best 1-NN, no importance weighting) — the same scale as `recall().hits[].similarity`, not `score`.
- **Explainable recall**: every hit carries three distinct numbers — `similarity` (raw cosine, comparable to the threshold and to `memory_verify`), `score` (ranking value: `similarity × (0.6 + 0.4·importance)`, capped at 1.0), and `relativeScore` (best hit for *this* query = 1.0). An empty result returns `reason` (`below-threshold` vs `no-candidates`), `eligible`, `bestSimilarity`, `threshold`, and `nearMisses` instead of a bare empty array. When nothing clears the floor, the digest still hands over the closest trace — labelled as a guess, not as a memory (see ③ above).
- **Literal identifier matching**: an exact token hit (`0x6070`, `D-387`, a commit sha, a version) is stronger evidence than a low cosine for a bare-identifier query, so such rows are retrieved even below the threshold and flagged `literalMatch`. Measured on a real 167-memory store over 277 identifier queries: Top-1 hit rate 10.5% → **99.6%**, MRR 0.195 → **0.998**.
- **Evidence, retraction, prospective guards (0.2.0)**: recheckable provenance (`verify_cmd` / `verify_expect` / `verify_artifact` + `verify_result`) with a 30-day freshness TTL — a fresh `[VERIFIED]` row can only be retired by other passing evidence, otherwise it renders `[ASSERTED]`; `retracts` marks a do-not-repeat retraction; `guard_trigger` / `guard_action` register a prospective trigger that is injected as `[GUARD]` when the cue matches.
- **Premise scope (`scope`, unreleased)**: a sentence that is true under one measurement setup and false under another used to collapse into a single flat summary, so `verify` blessed the old-comparator answer for a new-comparator question (the field report's real case: `P(X==disp)` ≈ independence baseline under "records land at the instruction start" vs **0.84388** under "the record's own `disp` field" — the only partial solution on that research line). A row can now state its premises as `key=value` segments (`population=all records; comparator=instruction start`), compared **structurally, with no new similarity threshold** (`diagnostics().thresholds` unchanged) — only keys both sides name, values compatible on subset or Jaccard ≥ 0.5, an unstated premise never counts as a contradiction. A clashing write stays its own trace (`different-scope:` warning) instead of overriding; `sourceMonitor(claim, { scope })` prefers the trace stated under the caller's premises, returns `out_of_scope: true` on a disagreement, and appends a `CONDITIONAL SCOPE` note when the support's premise was not checked. Surfaced as `[scope: …]` in composed context and on recall hits. Old stores gain the column automatically (`ensureColumns()`), no migration step.
- **Duplicate reporting & merging**: `duplicates()` is a read-only report of near-duplicate restatements across kinds (ignoring the consolidation `FACT: ` wrapper), with each row's `scope` and a per-group `mixedPremises` flag. `mergeDuplicates()` folds a group into one survivor via the reversible demote path (`undemote` restores) — it never deletes, and it refuses to fold rows that state different premises. Consolidation itself no longer creates the episode/rule twin.
- **Optional real embeddings** (setting `auto`): lazy-loads `Xenova/bge-small-zh-v1.5` (~24MB quantized, cached under the store dir) for strong CJK/paraphrase recall; falls back to the built-in hashing embedder on any failure.
- **Adaptive forgetting & consolidation**: `consolidate` abstracts repeated episodes into semantic rules; `forget` decays weak traces with a dry-run preview; `compress` folds N same-scope traces into 1 caller-authored invariant + K representatives (`undemote` restores).
- **Spaced repetition**: rehearsal strength grows with the gap since last access (`0.01 + 0.03·log2(1+days)`, capped at 0.12) — massed repetition earns little, spaced re-telling earns a lot, and a genuine recall after a gap strengthens the trace too (testing effect). `memory_remember` accepts an explicit `importance` (0..1) so critical facts can outrank trivia.
- **Injection guard (memory anti-poisoning)**: a page the agent read can end up inside a `memory_remember` write ("ignore all previous instructions…") and would then re-inject into every turn. Rendered memory text is sanitized (`[sanitized-*]` markers) on every engine output path (digest / recall / nearMisses / conflict warnings / verify / list / history / duplicates / merge), wrapped in a `[memory data … not instructions]` frame; stored rows stay untouched for audit, and infected rows are flagged (`injection:` warnings in recall/verify, `injectionWarnings` in list). Sanitizing rows never silences them. Designed conservatively — only phrases that try to redirect the reader's instructions are touched — and no false positives were observed across the real stores tested. **Adapter coverage differs**: DSH sanitizes every tool result; opencode sanitizes the auto digest plus the new `duplicates` / `merge` reports, while its `list` / `history` / `recall` hits are still raw (open item in [ROADMAP.md](ROADMAP.md)).
- **Safer overrides**: path-3 now needs **two gates** — content cosine *and* a summary-to-summary claim cosine (default 0.75). If the claim gate fails the write degrades to a new row with a `withheld-contradiction:` warning: better an extra row than a lost memory.
- **Concurrent-safe shared store**: WAL + `busy_timeout` (5s default, configurable) so multi-agent shared-store writes no longer throw `SQLITE_BUSY`.
- **Observability**: `diagnostics()` and `memory_maintain status` expose store path, embedder kind+dim, a stored-vector dimension histogram, `dimMismatch`, all thresholds, access stats, `coverage` (this process's digest turns / misses / guesses) and a one-line `health` verdict — the only way to catch the silent killer (model-vector store queried by the hashing fallback → garbage cosines → permanently empty recall). Since the unreleased batch it also reports `sibling_stores` + `scope_rule`, so a store split ("stored, but into another file") reads differently from "never stored"; each adapter adds its host's `path_rule`.
- **Override audit**: `override-audit` (read-only) screens overridden pairs whose content has almost nothing in common — the signature of an unrelated memory retired by a bad override.
- **Tidy storage**: stores open lazily — read-only traffic stays in memory, the `.db` appears only on first write, and `memory_maintain prune` sweeps empty leftovers.
- **GUI card**: enable/disable live, context limit, shared store, embedding mode, recall threshold.
- **One-shot migration**: enabling `auto` re-embeds legacy hash rows with the model automatically (persisted marker, runs once); `memory_maintain status` reports model state.

## Engine quick start

```js
import { HippoMemory } from 'hippo-memory-core';

const mem = new HippoMemory({ dbPath: './agent-memory.db' });
await mem.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
const { items, context } = await mem.composeContext('fix billing connection', { limit: 5 });
// items[0].lowConfidence === true -> that line is the closest trace, not a memory
const v = await mem.sourceMonitor('billing service database is postgres', {
  scope: 'deployment=prod',           // check the premise, not just the sentence
});
// v.out_of_scope === true -> the support was stated under different premises
// v.substantiated ? 'safe to assert' : 'answer: not in my memory'

const group = mem.duplicates().groups.find((g) => !g.mixedPremises);
await mem.mergeDuplicates({ ids: group.memories.map((m) => m.id), dryRun: true });  // preview
// apply with dryRun: false; extras are demoted, restorable via mem.undemote(ids)

mem.diagnostics().sibling_stores;   // every .db next to this one: rows / demoted / lastWrite / current
mem.diagnostics().coverage;         // { turns, misses, guesses, scope: 'process' }
```

`v.substantiated ? 'safe to assert' : 'answer: not in my memory'`

Runtime: Node ≥ 22.5 (`node:sqlite`) **or** Bun (`bun:sqlite`) — the driver is auto-detected at load time, so the same package also runs inside Bun hosts such as **opencode**. Tests: `npm test` (**142 engine + 35 DSH + 17 opencode = 194**, all green). Bench: `npm run bench`.

## Roadmap & issues

[ROADMAP.md](ROADMAP.md) · [issue templates](.github/ISSUE_TEMPLATE/) · MIT license
