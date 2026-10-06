/**
 * The `scope` field — stated premises a claim holds under (improvement
 * proposal P0-1b, from a 10-round reverse-engineering field report).
 *
 * The reported failure: one sentence that is TRUE under one measurement
 * setup and FALSE under another ("X is uncorrelated with the displacement"
 * holds when records are compared to the instruction start, breaks when they
 * are compared to the instruction's own disp field). A flat summary cannot
 * carry that distinction, so `verify` returned `substantiated: true` against
 * the old-scope row and the caller had no way to see the reversal.
 *
 * Contract under test:
 *   - `scope` round-trips through write/read/history.
 *   - `verify` prefers the trace whose scope matches the caller's, and says
 *     OUT_OF_SCOPE instead of substantiating a claim under foreign premises.
 *   - An unconditional support note appears when the stored row is
 *     conditional and the caller did not state a scope.
 *   - Compatible-or-absent scopes leave the existing write path untouched — except that
 *     an ABSENT scope on the incumbent never takes the caller's premise by rehearsal
 *     (G4: that was a silent narrowing; see "keeps the general row general").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HippoMemory } from '../dist/index.js';

function freshStore(options) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-scope-'));
  const file = join(dir, 'test.db');
  return { m: new HippoMemory({ dbPath: file }), dir, file };
}

test('scope: a write round-trips its stated premises', async () => {
  const { m, dir } = freshStore();
  try {
    const res = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE1 throughput saturates at the ring buffer size',
      scope: 'population=all records; comparator=instruction start'
    });
    assert.equal(res.memory.scope, 'population=all records; comparator=instruction start');
    assert.equal(m.get(res.memory.id).scope, res.memory.scope);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: rows without a scope keep verify exactly as it was', async () => {
  const { m, dir } = freshStore();
  try {
    const res = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE2 the archive builder runs on the cold node' });
    const v = await m.sourceMonitor('ZZSCOPE2 the archive builder runs on the cold node');
    assert.equal(v.out_of_scope, false);
    assert.equal(v.substantiated, true);
    assert.equal(v.support.scope, undefined);
    assert.ok(!/CONDITIONAL SCOPE|OUT_OF_SCOPE/.test(v.note), `note must stay clean: ${v.note}`);
    assert.equal(m.get(res.memory.id).scope, undefined);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: verify substantiates when the caller premises match the trace', async () => {
  const { m, dir } = freshStore();
  try {
    const a = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE3 the pair stays at the independence baseline',
      scope: 'population=all records; comparator=instruction start'
    });
    const v = await m.sourceMonitor('ZZSCOPE3 the pair stays at the independence baseline', {
      scope: 'comparator=instruction start of the lea-rsp site; population=all records'
    });
    assert.equal(v.support.id, a.memory.id);
    assert.equal(v.out_of_scope, false);
    assert.equal(v.substantiated, true);
    assert.equal(v.support.scope, a.memory.scope);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: verify answers OUT_OF_SCOPE when a shared key holds another value', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE4 the pair stays at the independence baseline',
      scope: 'population=all records; comparator=instruction start'
    });
    const v = await m.sourceMonitor('ZZSCOPE4 the pair stays at the independence baseline', {
      scope: 'comparator=disp field of the recorded instruction'
    });
    assert.equal(v.out_of_scope, true);
    assert.equal(v.substantiated, false);
    assert.match(v.note, /^OUT_OF_SCOPE/);
    assert.ok(v.note.includes('comparator'), `note must name the differing key: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: a conditional support without a caller scope is flagged, not blessed', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE5 the sample is drawn from the warm shard',
      scope: 'population=the first 4096 rows only'
    });
    const v = await m.sourceMonitor('ZZSCOPE5 the sample is drawn from the warm shard');
    assert.equal(v.out_of_scope, false);
    assert.equal(v.support.scope, 'population=the first 4096 rows only');
    assert.match(v.note, /CONDITIONAL SCOPE/);

    // The digest is where a stale conclusion actually reaches the model, so
    // the premise must travel with the line.
    const ctx = await m.composeContext('ZZSCOPE5 the sample is drawn from the warm shard');
    assert.ok(
      ctx.context.includes('[scope: population=the first 4096 rows only]'),
      `injected context must carry the premise: ${ctx.context}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: the trace stated under the caller premises wins over a closer foreign one', async () => {
  const { m, dir } = freshStore();
  try {
    const api = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE6 the eviction policy is least-recently-used',
      scope: 'service=api gateway'
    });
    const batch = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE6 the eviction policy is first-in-first-out',
      scope: 'service=batch importer'
    });

    // Asking the api conclusion under batch premises: the premise-aware pick is
    // the batch row (not the textually closer api one), and because that row
    // binds the subject to another value the verdict is CONTRADICTED — the
    // api-scope conclusion does not hold here (audit #7).
    const asBatch = await m.sourceMonitor('ZZSCOPE6 the eviction policy is least-recently-used', {
      scope: 'service=batch importer'
    });
    assert.equal(asBatch.out_of_scope, false, 'a premise-aware pick is not an out-of-scope answer');
    assert.ok(asBatch.contradiction, `the batch-scope row must be named: ${asBatch.note}`);
    assert.equal(asBatch.contradiction.id, batch.memory.id, 'the batch-scope trace is the one that disagrees');
    assert.equal(asBatch.contradicted, true, 'the claim does not hold under batch premises');

    // Under its own premises the same conclusion is supported by its own trace.
    const asApi = await m.sourceMonitor('ZZSCOPE6 the eviction policy is least-recently-used', {
      scope: 'service=api gateway'
    });
    assert.equal(asApi.substantiated, true, `the api-scope row must support it: ${asApi.note}`);
    assert.equal(asApi.support.id, api.memory.id);
    assert.equal(asApi.out_of_scope, false);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: the same sentence under a different scope is a new trace, not a rehearsal', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE7 the copy coverage floor is measured over live rows',
      scope: 'detector=the first pass',
      entities: [{ name: 'zzscope7' }]
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE7 the copy coverage floor is measured over live rows',
      scope: 'detector=the re-run pass',
      entities: [{ name: 'zzscope7' }]
    });
    assert.equal(second.outcome, 'new');
    assert.equal(m.stats().active, 2, 'both premises must survive');
    assert.match(second.warning ?? '', /scope/i);
    assert.equal(first.memory.scope, 'detector=the first pass');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: the same sentence under the same scope still rehearses', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZSCOPE8 the ledger is append-only', scope: 'shard=zero' });
    const again = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE8 the ledger is append-only', scope: 'shard=zero' });
    assert.equal(again.outcome, 'none');
    assert.equal(m.stats().active, 1);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: an update archives the premises it replaced', async () => {
  const { m, dir } = freshStore();
  try {
    const res = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE9 the flag defaults to off', scope: 'release=before the freeze' });
    const updated = await m.update(res.memory.id, { scope: 'release=after the freeze' });
    assert.equal(updated.memory.scope, 'release=after the freeze');
    const hist = m.history(res.memory.id);
    assert.equal(hist[0].scope, 'release=before the freeze');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * G4 (round 28 field report, and the ruling taken with it): a premise the incumbent
 * NEVER STATED is not a missing field to complete — it is a narrowing. `premiseFill`
 * used to attach the caller's scope to a premise-free row inside three rehearsal
 * branches and return `none` (or `merge`), which deleted the general statement while
 * reporting that nothing happened: measured on the installed bytes, 4 of 7 shapes lost
 * read coverage that way (`.hippo/probe-g4b-round28.txt` — verify under an unrelated
 * premise went substantiated → out_of_scope across a write that said `none`), and the
 * only thing separating the destroyed shape from the surviving one was whether the
 * caller re-typed the sentence verbatim.
 *
 * The ruling: refuse the narrowing, and let the pair coexist exactly as two keyed
 * premises already do (`different-scope`, the test above). The general row keeps
 * speaking for callers it was never told about; the caller's premise is recorded as its
 * own trace; an intentional narrowing stays available through `update()`, which
 * increments the version and archives the premise it replaced (test "an update archives
 * the premises it replaced"). What is gone is the silent one.
 */
test('scope: a re-tell that supplies the missing premise keeps the general row general', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE11 the retry budget is five attempts' });
    const again = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE11 the retry budget is five attempts',
      scope: 'env=the staging cluster'
    });
    assert.equal(again.outcome, 'new', 'a narrowing is a new trace, never a no-op');
    assert.equal(m.stats().active, 2, 'both rows stand: the general one and the conditioned one');
    const general = m.get(first.memory.id);
    assert.equal(general.scope, undefined, 'the general statement keeps its coverage');
    assert.match(String(again.warning ?? ''), /premise-narrowing:/, 'the caller is told WHY the pair appeared');

    const v = await m.sourceMonitor('ZZSCOPE11 the retry budget is five attempts', { scope: 'env=the blue cluster' });
    assert.equal(v.substantiated, true, 'the general row still answers a caller it was never told about');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The same predicate at the other two rehearsal sites. Both were live on the installed
 * bytes in the same probe (shapes E and G), so an assertion on the verbatim branch alone
 * would leave the narrowing reachable through a different outcome label — the G3 lesson,
 * one rule wired to one of its sites.
 */
test('scope: the structured-claim and cross-kind sites refuse the narrowing too', async () => {
  const { m, dir } = freshStore();
  try {
    const claim = 'ZZSCOPE12 queue depth -> 4000 messages';
    const first = await m.remember({ kind: 'semantic', summary: claim });
    const same = await m.remember({ kind: 'semantic', summary: claim, scope: 'tenant=the acme shard' });
    assert.equal(same.outcome, 'new', 'same subject, same value, a newly stated premise: its own trace');
    assert.equal(m.get(first.memory.id).scope, undefined);

    const episode = await m.remember({ kind: 'episode', summary: claim, scope: 'tenant=the acme shard' });
    assert.notEqual(episode.outcome, 'merge', 'the cross-kind site refuses it as well');
    assert.equal(m.get(first.memory.id).scope, undefined, 'and does not overwrite the general row');
    assert.ok(m.stats().active >= 2, `rows kept separate: ${m.stats().active}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R1 (round-30 field report, P0 on the write path): G4's refusal was wired INSIDE the
 * same-value branch of the path-0 override arm, so a keyed write whose value DIFFERS
 * reached the `override` return without ever asking whether the incumbent declared a
 * premise. Measured on the bytes the reporter ran (`.hippo/repro-r1r2r3-round30b.txt`,
 * identical in both embedding spaces): a premise-free "rate limit -> 1000 req/min" plus a
 * keyed write of "rate limit -> 100 req/min" under `tenant=acme` → `outcome: "override"`,
 * one active row carrying `tenant=acme`, one history row, and NO `premise-narrowing:` note.
 * The general statement was retired and rewritten under a premise it never stated, so the
 * sentence it held can no longer answer any caller — `verify` of it returns OUT_OF_SCOPE
 * under another tenant and WEAK_MATCH under none.
 *
 * The gate's question is "does the row already on file state a premise?", not "are the two
 * writes verbatim identical". The reporter's rule, which this test pins: a different value
 * under a newly stated premise is the case that MOST needs both readings on file — the
 * general one and the conditioned one — not the case that justifies deleting one.
 *
 * Controls kept on purpose (each is a shape the fix must not move, and each is measured in
 * the price census): two premise-free rows with different values still override (no
 * premise is at stake), a keyed incumbent under the SAME premise still versions, a keyed
 * incumbent under ANOTHER premise still coexists with `different-scope:`.
 */
test('scope: a DIFFERENT-VALUE keyed write over a premise-free row keeps that row general too', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE17 rate limit -> 1000 req/min', entities: ['zzlimiter17'] });
    const again = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE17 rate limit -> 100 req/min',
      entities: ['zzlimiter17'],
      scope: 'tenant=the acme shard'
    });
    assert.equal(again.outcome, 'new', `a narrowing at a different value is still a narrowing: ${again.outcome}`);
    assert.equal(m.stats().active, 2, 'both the general statement and the conditioned one stand');
    assert.equal(m.get(first.memory.id).scope, undefined, 'the general row is not rewritten under the caller premise');
    assert.equal(m.history(first.memory.id).length, 0, 'and nothing is retired by it');
    assert.match(String(again.warning ?? ''), /premise-narrowing:/, 'the caller is told the pair was kept apart, and why');

    const v = await m.sourceMonitor('ZZSCOPE17 rate limit -> 1000 req/min', { scope: 'tenant=the globex shard' });
    assert.equal(v.substantiated, true, `the retired-general sentence must still answer: ${v.note}`);
    assert.equal(v.out_of_scope, false, `a tenant the general row never named may not veto it: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The write-side control the R1 fix must not swallow: the incumbent itself states a
 * premise, so a value flip under THAT premise is a correction, not a narrowing — the
 * version chain stays. Pinned next to the fix because the predicate both shapes share is
 * `narrowsPremiseFree`, and one branch of it being right does not prove the other survived.
 */
test('scope guard: a premise-free row is the only incumbent a narrowing refuses', async () => {
  const { m, dir } = freshStore();
  try {
    const keyed = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE18 queue depth -> 4000 messages',
      entities: ['zzqueue18'],
      scope: 'tenant=the acme shard'
    });
    const fixed = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE18 queue depth -> 8000 messages',
      entities: ['zzqueue18'],
      scope: 'tenant=the acme shard'
    });
    assert.equal(fixed.outcome, 'override', 'same stated premise, different value: a correction retires the old one');
    assert.equal(keyed.memory.id, fixed.memory.id, 'and it stays the same row');
    assert.equal(m.stats().active, 1, `no pair appears where none is owed: ${m.stats().active}`);
    assert.doesNotMatch(String(fixed.warning ?? ''), /premise-narrowing:/, 'nothing was narrowed: the premise was already on file');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R1's SECOND site, found by re-running the reporter's reproduction against the build that
 * carries the path-0 fix (`.hippo/repro-r1r2r3-round30b-postfix.txt`, bge arms). Refusing at
 * path-0 only makes the write skip THAT arm: the similarity-driven arm further down
 * (`brink` / path-3, gated on content-sim ≥ 0.86 plus claim-sim ≥ 0.75 + shared entities +
 * identical structured subject) then retires the same premise-free row. Under
 * `bge-small-zh-v1.5` that is what happens: `outcome=override`, the warning reads
 * `override: this write retired … Trigger: path-3 content-sim 0.90 + claim-sim 0.95 …`, one
 * active row carrying `tenant=acme`, one history row, and the general statement unreachable.
 * The path-0 refusal DID record the narrowing on that build, but the override arm returns its
 * own warning string (`src/memory.ts:1428`), so `narrowWarning` was made and then dropped —
 * the caller got a destructive write with no explanation, which is the G4 complaint in a new
 * coat. In the hashing space the pair scores ~0.55 and never reaches `brink`, which is why
 * 417 items could carry both a passing write-side suite and a live P0. This is the G3 lesson
 * verbatim: a rule wired to one of its two retirement sites is not a rule.
 *
 * The store below therefore supplies the shape only a semantic model produces — both
 * wordings embed to one vector — with the same stand-in-device rule as
 * `test/recall-anchors.test.mjs`.
 */
function narrowEmbedder() {
  return {
    dim: 3,
    embed: async (texts) => texts.map((t) => (t.includes('rate limit') ? [1, 0, 0] : [0, 1, 0]))
  };
}

function narrowStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-narrow-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  m.setEmbedder(narrowEmbedder());
  return { m, dir };
}

test('scope: the similarity-driven override arm refuses to narrow a premise-free row too', async () => {
  const { m, dir } = narrowStore();
  try {
    const first = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE19 rate limit -> 1000 req/min', entities: ['zzlimiter19'] });
    const again = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE19 rate limit -> 100 req/min',
      entities: ['zzlimiter19'],
      scope: 'tenant=the acme shard'
    });
    assert.equal(again.outcome, 'new', `neither retirement arm may narrow it: ${again.outcome} / ${String(again.warning ?? '')}`);
    assert.equal(m.stats().active, 2, 'the general row and the conditioned one both stand');
    assert.equal(m.get(first.memory.id).scope, undefined, 'the general row keeps its coverage');
    assert.equal(m.history(first.memory.id).length, 0, 'and nothing is archived on the way');
    assert.match(String(again.warning ?? ''), /premise-narrowing:/, 'the refusal is stated at the exit the caller reads');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The read-side companion the coexistence ruling needs, and its exact boundary.
 *
 * D2 (an earlier round of the same field report) established that a scope-less row which
 * merely SHARES AN ENTITY with the claim must not bless a premise-bound claim: the store
 * holds "gto 内存上限 4GB" under env=prod plus an unscoped observation, and a caller
 * asking about env=dev gets OUT_OF_SCOPE with the prod row named. That ruling stands, and
 * this test is its guard.
 *
 * What D2 did not consider is the shape the coexistence ruling now produces on purpose:
 * the premise-free row IS the claim, word for word. Refusing that one makes the general
 * statement unable to answer the question it was written to answer, and the note's own
 * wording ("which states no premise answers this no better") would contradict
 * `scopeCanSupport`'s premise-free branch. So the exemption is identity, not proximity —
 * the SAME criterion the write path uses to refuse the narrowing, which is why the pair
 * and the exemption can never disagree about what "the same sentence" means.
 */
test('scope: a premise-free row that RESTATES the claim answers a caller a keyed twin contradicts', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZSCOPE14 the flush interval is thirty seconds', entities: ['flusher'] });
    await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE14 the flush interval is thirty seconds',
      entities: ['flusher'],
      scope: 'env=the staging cluster'
    });
    const v = await m.sourceMonitor('ZZSCOPE14 the flush interval is thirty seconds', { scope: 'env=the blue cluster' });
    assert.equal(v.substantiated, true, `the general statement must still answer: ${v.note}`);
    assert.equal(v.out_of_scope, false);
    assert.ok(
      (v.scope_conflicts ?? []).length > 0,
      'and the twin that holds another premise stays named, not silently absent'
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The twin must be named even when it is too far down the ranking to reach the veto by
 * score or by subject — the shape the round-28 after-fix panel measured
 * (`.hippo/probe-g4d-round28.mjs`, arm A: general row 0.7746, keyed twin 0.5906, both
 * `anchored: ["vocabulary"]`).
 *
 * This is the G4 exemption's own edge, and it cuts the other way than it looks. The
 * exemption reads "this row is the claim word for word, so it may answer"; the same fact
 * is the STRONGEST possible answer to "is that row about the same thing as my question",
 * so a twin that restates the claim verbatim under a contradicting premise is more
 * relevant to this verdict than a row the caller has to score-match against. Letting it
 * vanish from `scope_conflicts[]` would print `substantiated` plus an empty list next to
 * a store that holds a direct contradiction of the caller's premise — the F-batch lesson
 * ("a promise reachable at only one exit reads as a broken promise") arriving through the
 * door this round built.
 *
 * Fixture text is deliberately the panel's, not a `ZZSCOPE16` marker: an id-shaped token
 * shared by both rows would raise the identifier tier, the veto would reach by the anchor
 * route, and the test would go green before the route it pins exists.
 */
test('scope: a verbatim twin the caller contradicts is named even when it cannot reach the veto by score', async () => {
  const { m, dir } = freshStore();
  const CLAIM = 'database vacuum runs nightly';
  try {
    await m.remember({ kind: 'semantic', summary: CLAIM, tags: ['fact'], entities: ['db-op'] });
    await m.remember({ kind: 'semantic', summary: CLAIM, tags: ['fact'], entities: ['db-op'], scope: 'db=primary' });
    const v = await m.sourceMonitor(CLAIM, { scope: 'db=replica' });
    assert.equal(v.substantiated, true, `the general row still covers this caller: ${v.note}`);
    assert.equal(v.out_of_scope, false);
    assert.equal((v.scope_conflicts ?? []).length, 1, 'the keyed twin is named even at a lower score');
    assert.equal(String(v.scope_conflicts[0].scope), 'db=primary');
    assert.match(v.note, /restate this SAME sentence/);
    assert.match(v.note, /"db=primary"/, 'the note names the twin premise it is reporting');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The comparison arm for the test above: the SAME twin, beside a premise-free row that is a
 * PARAPHRASE rather than the sentence itself, so the exemption is not in play and the yes
 * must not happen.
 *
 * Round 28 wrote this arm to prove the veto's score route survived the identity route — on a
 * support that held the seat. R2 (round 30) moved the seat. A premise-free row that carries
 * no anchor to this claim is not evidence about the caller's question, so the keyed row that
 * IS the claim now wins it and vetoes FROM the seat (via `supportDiffers`) instead of
 * arriving as a second name in `scope_conflicts`. Measured: `.hippo/probe-arm16-round30.txt`
 * ran five paraphrase wordings of this sentence and all five read `anchored=no` and lost the
 * seat, at support sim 0.591 for the twin. Both readings of this store answer OUT_OF_SCOPE —
 * what changed is which row the answer points at, and pointing at the row that states the
 * contradicted premise is the fix rather than a regression.
 *
 * The invariant this arm owns is unchanged and asserted below: a paraphrase earns no
 * exemption. The identity route round 28 added is still pinned by the test above, where the
 * premise-free row holds the seat by restating the claim.
 */
test('scope: a paraphrase premise-free row earns no exemption, and the keyed twin stops the yes from the seat', async () => {
  const { m, dir } = freshStore();
  const CLAIM = 'database vacuum runs nightly';
  try {
    const paraphrase = await m.remember({ kind: 'semantic', summary: 'a nightly vacuum pass over the database tables', tags: ['fact'], entities: ['db-op'] });
    const twin = await m.remember({ kind: 'semantic', summary: CLAIM, tags: ['fact'], entities: ['db-op'], scope: 'db=primary' });
    const v = await m.sourceMonitor(CLAIM, { scope: 'db=replica' });
    assert.equal(v.substantiated, false, 'a paraphrase carries no exemption');
    assert.equal(v.out_of_scope, true, `the store holds the claim under a premise the caller contradicts: ${v.note}`);
    assert.equal(v.support?.id, twin.memory.id, `the twin takes the seat from an unanchored paraphrase (R2): ${JSON.stringify(v.support)}`);
    assert.notEqual(v.support?.id, paraphrase.memory.id);
    assert.match(String(v.note), /db=primary/, `the note names the premise the caller contradicts: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * D2 guard, restated here so the exemption above cannot quietly widen: a scope-less row
 * that does NOT restate the claim still loses to a premise-bound one.
 */
test('scope guard: a scope-less neighbour is not a general statement', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZSCOPE15 cache hit ratio 4GB limit applies', entities: ['gateway'], scope: 'env=prod' });
    await m.remember({ kind: 'semantic', summary: 'ZZSCOPE15 the gateway needs attention', entities: ['gateway'] });
    const v = await m.sourceMonitor('ZZSCOPE15 cache hit ratio 4GB limit applies', { scope: 'env=dev' });
    assert.equal(v.out_of_scope, true, `a different sentence states no premise about this one: ${v.note}`);
    assert.equal(v.substantiated, false);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Two guards on the side that must NOT change: a re-tell that states nothing leaves the
 * recorded premise alone (a premise-free echo must not erase what a row holds "under"),
 * and a re-tell under the SAME premise still rehearses instead of duplicating. Refusing
 * the narrowing must not turn every scoped re-tell into a new row, or the store fills
 * with the pairs `different-scope` was written to avoid.
 */
test('scope guards: a stated premise survives a premise-free re-tell, and an identical one rehearses', async () => {
  const { m, dir } = freshStore();
  try {
    const keyed = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE13 the quorum is three replicas', scope: 'env=the staging cluster' });
    const bare = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE13 the quorum is three replicas' });
    assert.equal(bare.outcome, 'none');
    assert.equal(bare.memory.scope, 'env=the staging cluster', 'a premise-free echo never clears it');
    assert.equal(m.stats().active, 1);

    const again = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE13 the quorum is three replicas', scope: 'env=the staging cluster' });
    assert.equal(again.outcome, 'none', 'the same premise under the same sentence is rehearsal');
    assert.equal(m.stats().active, 1, `no duplicate pair: ${m.stats().active} rows`);
    assert.ok(keyed.memory.id === again.memory.id, 'and it stays the same row');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: a store written before the column existed still opens and gains one', async () => {
  const { m, dir, file } = freshStore();
  try {
    const res = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE10 the quorum is three replicas' });
    m.close();

    const raw = new DatabaseSync(file);
    try {
      raw.exec('ALTER TABLE memories DROP COLUMN scope;');
    } finally {
      raw.close();
    }

    const reopened = new HippoMemory({ dbPath: file });
    try {
      assert.equal(reopened.get(res.memory.id).scope, undefined);
      const moved = await reopened.remember({
        kind: 'semantic',
        summary: 'ZZSCOPE10 the quorum is three replicas',
        scope: 'cluster=the eu region'
      });
      assert.equal(moved.memory.scope, 'cluster=the eu region');
      const v = await reopened.sourceMonitor('ZZSCOPE10 the quorum is three replicas', { scope: 'cluster=the apac region' });
      // G4 changed WHICH row answers here. Before it, the scoped re-tell silently narrowed
      // the migrated row, so `v.support.scope` was the eu premise and the store had one row
      // covering nothing outside it. Now the legacy row stays general and keeps answering a
      // caller the eu row excludes, while the row that gained the premise stays named — which
      // is the migration test's actual question: does a store that predates the column still
      // record, check and report premises?
      assert.equal(v.substantiated, true, `the migrated premise-free row is a general statement: ${v.note}`);
      assert.ok(
        (v.scope_conflicts ?? []).some((r) => r.scope === 'cluster=the eu region'),
        'the row that states the premise is named, not swallowed'
      );
      const own = await reopened.sourceMonitor('ZZSCOPE10 the quorum is three replicas', { scope: 'cluster=the eu region' });
      assert.equal(own.support.scope, 'cluster=the eu region', 'and its premise is checkable under itself');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: the different-scope warning counts each blocked row once', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({
      kind: 'semantic',
      summary: 'zzs13 cache hit ratio -> 1.35 per cent',
      scope: 'population=the first 4096 rows; comparator=instruction start'
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'zzs13 cache hit ratio -> 1.35 per cent',
      scope: 'population=all records; comparator=decode completion'
    });
    const warning = second.warning ?? '';
    assert.match(warning, /^different-scope: kept as its own trace — 1 row\(s\)/);
    assert.equal(
      warning.split(first.memory.id.slice(0, 8)).length - 1,
      1,
      `the incumbent should be named exactly once, got: ${warning}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------- */
// Round 17 (black-box field report): every case above writes the premise in
// the documented `key=value` form. A model that instead writes the bare value
// — `scope: "us-east"`, which is exactly what a natural sentence produces —
// used to get NO premise checking at all, because `scopeDifferences` only
// compares keys both sides name and an unkeyed segment becomes a key of its
// own. Two different bare premises therefore never shared a key, never
// disagreed, and the ranking read the foreign row as "the caller's own
// premises" (rank 2): the claim was stamped SUBSTANTIATED against a trace
// stated under a different condition. That is the dangerous side, and it is
// the whole scope feature silently disabled, not one verdict.
//
// Contract: an unkeyed premise names THE condition, so a different unkeyed
// premise is a disagreement. It is still compatible when it restates or
// refines the same words, and it is compatible across forms (bare `us-east`
// matches `region=us-east`). Two keyed premises under two different keys stay
// NON-conflicting — naming another axis is not disagreeing.

test('scope: two unkeyed premises that differ must not support each other', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZBARE1 the api timeout is thirty seconds', scope: 'us-east' });
    const v = await m.sourceMonitor('ZZBARE1 the api timeout is thirty seconds', { scope: 'ap-south' });
    assert.equal(v.substantiated, false, `a foreign unkeyed premise must not bless the claim: ${v.note}`);
    assert.equal(v.out_of_scope, true, `the disagreement must be reported: ${v.note}`);
    assert.match(v.note, /^OUT_OF_SCOPE/);
    assert.ok(v.note.includes('us-east') && v.note.includes('ap-south'), `both premises must be quoted: ${v.note}`);
    // The reason must read as a fact about the caller's premises, not as a
    // dump of an internal bucket name: an unkeyed premise has no key to name.
    assert.match(v.note, /neither side keys its premise/, `plain-language reason expected: ${v.note}`);
    assert.ok(!v.note.includes('key(s) unkeyed-premise'), `no internal token may reach the reader: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: the same unkeyed premise restated still supports', async () => {
  const { m, dir } = freshStore();
  try {
    const row = await m.remember({ kind: 'semantic', summary: 'ZZBARE2 the queue drains hourly', scope: 'us-east' });
    const v = await m.sourceMonitor('ZZBARE2 the queue drains hourly', { scope: 'us-east' });
    assert.equal(v.out_of_scope, false, `identical premises cannot disagree: ${v.note}`);
    assert.equal(v.substantiated, true, `the caller's own premise must support it: ${v.note}`);
    assert.equal(v.support.id, row.memory.id);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: an unkeyed premise refines a keyed one without conflicting', async () => {
  const { m, dir } = freshStore();
  try {
    const row = await m.remember({
      kind: 'semantic',
      summary: 'ZZBARE3 the shard count is twelve',
      scope: 'region=us-east'
    });
    // The caller names the same condition without the key: same words, so the
    // row is the caller's own premise and must win the ranking, not be vetoed.
    const v = await m.sourceMonitor('ZZBARE3 the shard count is twelve', { scope: 'us-east' });
    assert.equal(v.out_of_scope, false, `cross-form restatement is not a disagreement: ${v.note}`);
    assert.equal(v.support.id, row.memory.id, `the keyed row must be the support: ${v.note}`);
    assert.equal(v.substantiated, true, `and must support it: ${v.note}`);

    // Refinement of the unkeyed side, same direction.
    const wide = await m.sourceMonitor('ZZBARE3 the shard count is twelve', { scope: 'the us-east zone' });
    assert.equal(wide.out_of_scope, false, `a broader wording of the same premise is not a conflict: ${wide.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: an unkeyed premise conflicting with a keyed one is out of scope', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZBARE4 the replica lag is under a second', scope: 'region=us-east' });
    const v = await m.sourceMonitor('ZZBARE4 the replica lag is under a second', { scope: 'eu-west' });
    assert.equal(v.substantiated, false, `the bare premise must not silently match a keyed one: ${v.note}`);
    assert.equal(v.out_of_scope, true, `cross-form disagreement is still a disagreement: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: two unkeyed premises keep their own traces on the write path', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({
      kind: 'semantic',
      summary: 'ZZBARE5 the burst ceiling is two thousand',
      scope: 'the staging cluster',
      entities: [{ name: 'zzbare5' }]
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'ZZBARE5 the burst ceiling is two thousand',
      scope: 'the production cluster',
      entities: [{ name: 'zzbare5' }]
    });
    assert.equal(second.outcome, 'new', `two different unkeyed premises are two facts: ${second.outcome}`);
    assert.equal(m.stats().active, 2, 'neither premise may fold into the other');
    assert.match(second.warning ?? '', /scope/i, 'and the skip must be visible');

    const same = await m.remember({
      kind: 'semantic',
      summary: 'ZZBARE5 the burst ceiling is two thousand',
      scope: 'the staging cluster',
      entities: [{ name: 'zzbare5' }]
    });
    assert.equal(same.outcome, 'none', 'the first premise still rehearses against itself');
    assert.equal(m.stats().active, 2);
    assert.equal(first.memory.scope, 'the staging cluster');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: recall drops rows whose unkeyed premise disagrees with the cue', async () => {
  const { m, dir } = freshStore();
  try {
    const ours = await m.remember({ kind: 'semantic', summary: 'ZZBARE6 the retention window is fourteen days', scope: 'the paid tier' });
    await m.remember({ kind: 'semantic', summary: 'ZZBARE6 the retention window is fourteen days', scope: 'the free tier' });
    const bundle = await m.recall({ query: 'ZZBARE6 the retention window is fourteen days', scope: 'the paid tier' }, 8);
    assert.ok(bundle.hits.some((h) => h.id === ours.memory.id), 'the caller premise row must be kept');
    assert.equal(bundle.hits.length, 1, `the foreign unkeyed premise must be filtered out: ${bundle.hits.length} hits`);
    assert.ok(bundle.scopeExcluded === undefined || bundle.scopeExcluded >= 1);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guard, RE-RULED by round 24 (D5). The half that still holds: F1's unkeyed
// premise widening must not turn "names a different key" into "states the
// opposite condition" — `region` and `release` never disagree, so no conflict may
// be collected, and reading one as the other would veto every multi-premise store
// and reverse field report D2's intent. The half that did not hold: this test used
// to assert `out_of_scope: false` and stop there, which the engine then read as
// "therefore support". Round 24 measured that consequence as a false
// certification (a trace under `tenant=acme` answering a claim checked under
// `cluster=blue` at 0.909), and `scopeCanSupport` now refuses it. Not a conflict
// and not a yes are two findings, and both are pinned here.
test('scope guard: different keyed premises do not conflict, and do not certify either', async () => {
  const { m, dir } = freshStore();
  try {
    const row = await m.remember({
      kind: 'semantic',
      summary: 'ZZBARE7 the canary window is one hour',
      scope: 'region=us-east'
    });
    const v = await m.sourceMonitor('ZZBARE7 the canary window is one hour', { scope: 'release=after the freeze' });
    assert.deepEqual(v.scope_conflicts, [], `another key is not a contradiction: ${JSON.stringify(v.scope_conflicts)}`);
    assert.equal(v.contradicted, false, `and not an opposition either: ${v.note}`);
    assert.equal(v.substantiated, false, `nor support for a premise it never names: ${v.note}`);
    assert.equal(v.out_of_scope, true, `${v.note}`);
    assert.equal(v.support.id, row.memory.id, 'the trace stays visible for inspection');
    assert.match(v.note, /region/, `the note must name the axis the trace keys: ${v.note}`);
    assert.match(v.note, /release/, `and the axis the caller stated: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F2 (black-box report #3): the related-row scan ignored premises.
//
// `related` feeds `contradicting`, `newer_related` and the archive tiers, and
// the type comment promised "Same-scope rows" while the code filtered only on
// similarity and entity overlap. Measured consequence: verifying a claim under
// `region=us-east` reported `stale_support: true` and "a NEWER trace exists on
// this scope" while naming the `region=eu-west` row — a false warning built from
// a trace the caller never asked about, with a note asserting the opposite of
// what the engine knew.
// Contract: a related row must not state a premise conflicting with the scope
// the claim is checked under (or, when the caller stated none, with the
// support's own premise). Rows stating no premise stay — a premise-free
// correction is still a correction.
// ---------------------------------------------------------------------------

/** Force `id` to be strictly newer than `than` without relying on wall-clock luck. */
async function ensureNewer(m, id, than) {
  if (m.get(id).updatedAt > m.get(than).updatedAt) return;
  await m.update(id, { detail: 'timestamp bump for the newer-trace ordering' });
}

test('F2: a newer row under a foreign premise does not make the support stale', async () => {
  const { m, dir } = freshStore();
  try {
    const support = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL1 the retry budget is five attempts',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel1' }]
    });
    const foreign = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL1 the retry budget is fifteen attempts',
      scope: 'region=eu-west',
      entities: [{ name: 'zzrel1' }]
    });
    await ensureNewer(m, foreign.memory.id, support.memory.id);
    assert.equal(m.stats().active, 2, 'the two premises must stand side by side for this to test anything');

    const v = await m.sourceMonitor('ZZREL1 the retry budget is five attempts', { scope: 'region=us-east' });
    assert.equal(v.support.id, support.memory.id, `the caller's own premise must be the support: ${v.note}`);
    assert.deepEqual(
      v.newer_related.map((r) => r.id),
      [],
      `the eu-west trace is not a newer word on the us-east claim: ${JSON.stringify(v.newer_related)}`
    );
    assert.equal(v.stale_support, false, 'no stale flag may be raised off a foreign premise');
    assert.ok(!/NEWER trace/.test(v.note), `the note must stay silent: ${v.note}`);
    assert.equal(v.contested, false, `a contested yes needs a same-premise challenger: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: a contradiction stated under a foreign premise is not reported', async () => {
  const { m, dir } = freshStore();
  try {
    const support = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL2 the nightly batch completes before midnight',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel2' }]
    });
    const foreign = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL2 the nightly batch does not complete before midnight',
      scope: 'region=eu-west',
      entities: [{ name: 'zzrel2' }]
    });
    await ensureNewer(m, foreign.memory.id, support.memory.id);
    assert.equal(m.stats().active, 2);

    const v = await m.sourceMonitor('ZZREL2 the nightly batch completes before midnight', { scope: 'region=us-east' });
    assert.deepEqual(
      v.contradicting.map((r) => r.id),
      [],
      `the eu-west negation says nothing about us-east: ${JSON.stringify(v.contradicting)}`
    );
    assert.ok(!/assert the OPPOSITE/.test(v.note), `no opposition warning may be raised: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: with no caller scope the support states the premises to compare against', async () => {
  const { m, dir } = freshStore();
  try {
    const support = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL3 the failover window is ninety seconds',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel3' }]
    });
    const foreign = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL3 the failover window is twelve seconds',
      scope: 'region=eu-west',
      entities: [{ name: 'zzrel3' }]
    });
    await ensureNewer(m, foreign.memory.id, support.memory.id);

    const v = await m.sourceMonitor('ZZREL3 the failover window is ninety seconds');
    assert.equal(v.support.id, support.memory.id, `the support must still be found: ${v.note}`);
    assert.deepEqual(v.newer_related.map((r) => r.id), [], 'the foreign-premise row is filtered against the support scope');
    assert.equal(v.stale_support, false);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guards (must stay green before AND after): the filter must not silence real
// staleness. Two shapes survive it — a newer row stating no premise at all, and
// a newer row under the caller's own premise.
test('F2 guard: a newer premise-free row still flags the support as stale', async () => {
  const { m, dir } = freshStore();
  try {
    const support = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL4 the failover window is ninety seconds',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel4' }]
    });
    const bare = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL4 the failover runbook is owned by the platform team',
      entities: [{ name: 'zzrel4' }]
    });
    await ensureNewer(m, bare.memory.id, support.memory.id);

    const v = await m.sourceMonitor('ZZREL4 the failover window is ninety seconds', { scope: 'region=us-east' });
    assert.ok(
      v.newer_related.some((r) => r.id === bare.memory.id),
      `a row stating no premise is not excluded for disagreement: ${JSON.stringify(v.newer_related)}`
    );
    assert.equal(v.stale_support, true, `and it must still be able to age the support: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2 guard: a newer row under the caller own premise still flags staleness', async () => {
  const { m, dir } = freshStore();
  try {
    const support = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL5 the retry budget is five attempts',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel5' }]
    });
    const sameScope = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL5 the circuit breaker threshold is nine failures',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel5' }]
    });
    await ensureNewer(m, sameScope.memory.id, support.memory.id);
    assert.equal(m.stats().active, 2, 'different subjects under one premise coexist by design');

    const v = await m.sourceMonitor('ZZREL5 the retry budget is five attempts', { scope: 'region=us-east' });
    assert.ok(
      v.newer_related.some((r) => r.id === sameScope.memory.id),
      `the same-premise newer neighbour must survive the filter: ${JSON.stringify(v.newer_related)}`
    );
    assert.equal(v.stale_support, true);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2 (round-30 field report): the seat, and who may sit in it.
//
// `rank()` gave a premise-free row 1 and an off-axis keyed row -1 on the argument that a
// row stating no premise "cannot be wrong for this scope". Measured on the bytes the
// reporter ran, that let a row about DATABASE VACUUM take the support seat from a row that
// is the caller's claim character for character, and the trace the caller actually needed
// then appeared in none of support / contradicting / newer_related / scope_conflicts
// (`.hippo/repro-r1r2r3-round30b.txt`, bge arms: BEFORE delete `weak_match support=… 0.622
// null "database vacuum runs nightly at 03"` with the twin invisible; AFTER deleting the
// two vacuum rows the same query answers `out_of_scope` naming it at 0.860). Delete-isolation
// is what proved the seat, not the score, did it — the hijacker scores LOWER.
//
// This suite runs on the hashing embedder, and the hashing embedder cannot produce the
// fixture: `.hippo/probe-r2-hashing-fixture.txt` measured five unanchored English sentences
// against the same claim and every one of them lands below the 0.32 recall floor, so none
// ever reaches the ranking (which is also why 417 items missed this). The store below
// therefore carries its own 3-dimensional stand-in model — the same device
// `test/recall-anchors.test.mjs` uses for "the shape a semantic model produces constantly"
// — with vectors normalised so the printed similarities are the ones the table claims.
// ---------------------------------------------------------------------------

const R2_CLAIM = 'api timeout -> 30 seconds';

function seatEmbedder() {
  const table = [
    ['api timeout', [1, 0, 0]], // the cue and its verbatim twin: cos 1.000 between them
    ['vacuum', [0.62, 0.7846, 0]] // topically far, still above the 0.32 floor: cos 0.620
  ];
  return {
    dim: 3,
    embed: async (texts) =>
      texts.map((t) => {
        const hit = table.find(([word]) => t.includes(word));
        return hit ? hit[1] : [0, 1, 0];
      })
  };
}

function seatStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-seat-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  m.setEmbedder(seatEmbedder());
  return { m, dir };
}

test('scope: a premise-free row about ANOTHER subject may not take the support seat from the trace that IS the claim', async () => {
  const { m, dir } = seatStore();
  try {
    const general = await m.remember({ kind: 'semantic', tags: ['fact'], summary: 'database vacuum runs nightly at 03:00', entities: ['flusher'] });
    const twin = await m.remember({ kind: 'semantic', tags: ['fact'], summary: R2_CLAIM, entities: ['gateway'], scope: 'service=billing' });
    assert.equal(m.stats().active, 2, 'the pair the reporter measured');

    const v = await m.sourceMonitor(R2_CLAIM, { scope: 'cluster=blue' });
    assert.equal(
      v.support?.id,
      twin.memory.id,
      `the trace that restates the claim keeps the seat even at a foreign premise, over a 0.62 general row about something else (support was ${v.support?.id === general.memory.id ? 'the premise-free row' : v.support?.id}): ${v.note}`
    );
    assert.equal(v.out_of_scope, true, `and the answer says WHY: ${v.note}`);
    assert.equal(v.substantiated, false);
    assert.match(String(v.note), /service=billing/, 'the named premise is the one the caller contradicts');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The boundary of the demotion, so it cannot become "premise-free rows lose": a
 * premise-free row that STATES the caller's claim keeps rank 1 and answers the caller a
 * keyed twin contradicts. Same predicate as the fix above (`sameThingAnchor` on the
 * identifier/subject tiers, or verbatim identity), read from the other side — the general
 * statement is not demoted for stating no premise, only for being about something else.
 * The hashing-space companion of this guard is "a premise-free row that RESTATES the claim
 * answers a caller a keyed twin contradicts" above.
 */
test('scope guard: a premise-free row that IS about the claim keeps the seat in the same landscape', async () => {
  const { m, dir } = seatStore();
  try {
    const general = await m.remember({ kind: 'semantic', tags: ['fact'], summary: R2_CLAIM, entities: ['gateway'] });
    await m.remember({ kind: 'semantic', tags: ['fact'], summary: 'database vacuum runs nightly at 03:00', entities: ['flusher'] });
    const v = await m.sourceMonitor(R2_CLAIM, { scope: 'cluster=blue' });
    assert.equal(v.support?.id, general.memory.id, `a general statement of the claim still answers: ${v.note}`);
    assert.equal(v.substantiated, true, `${v.note}`);
    assert.equal(v.out_of_scope, false, `${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R3 (round-30 field report, P1): a stale-support note that points at an empty array.
// Third round the same shape is reported (`contested`/`stale` prose naming a field the
// answer leaves empty): G3 fixed the false conflicts, F2 the false "assert the OPPOSITE",
// this one is the attribution of a REAL flag. `staleSupport` fires on
// `newerRelated.length > 0 || supersededMatches.length > 0`, but `staleNote` was written
// for the first cause only, so an archived revision of the support printed
// "Review newer_related" with `newer_related: []` — measured in
// `.hippo/repro-r1r2r3-round30b.txt` (R3 arm, both spaces).
// ---------------------------------------------------------------------------

test('R3: staleness earned by an archived revision names superseded_matches, never an empty newer_related', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({ kind: 'semantic', summary: 'ZZREL6 api timeout -> 30 seconds', entities: [{ name: 'zzrel6' }] });
    const again = await m.remember({ kind: 'semantic', summary: 'ZZREL6 api timeout -> 60 seconds', entities: [{ name: 'zzrel6' }] });
    assert.equal(again.outcome, 'override', 'this shape needs the archive chain, and neither side states a premise');
    assert.equal(first.memory.id, again.memory.id, 'one row, second version');

    const v = await m.sourceMonitor('ZZREL6 api timeout -> 60 seconds');
    assert.equal(v.substantiated, true, `the live value still answers: ${v.note}`);
    assert.equal(v.stale_support, true, 'an archived revision of the support does age it');
    assert.deepEqual(
      v.newer_related.map((r) => r.id),
      [],
      `nothing is newer than the live row: ${JSON.stringify(v.newer_related)}`
    );
    assert.ok(v.superseded_matches.length > 0, 'the flag comes from the archived revision');
    assert.equal(v.contested, true);
    assert.doesNotMatch(String(v.note), /newer_related/, `the note may not send the reader to an empty list: ${v.note}`);
    assert.match(String(v.note), /superseded_matches/, `and must name the list that holds the evidence: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The other half of the attribution: when `newer_related` IS populated the note must still
 * say so. Without this guard the fix could pass by deleting the sentence outright.
 */
test('R3 guard: staleness earned by a newer related trace still names newer_related', async () => {
  const { m, dir } = freshStore();
  try {
    const support = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL7 the failover window is ninety seconds',
      scope: 'region=us-east',
      entities: [{ name: 'zzrel7' }]
    });
    const bare = await m.remember({
      kind: 'semantic',
      summary: 'ZZREL7 the failover runbook is owned by the platform team',
      entities: [{ name: 'zzrel7' }]
    });
    await ensureNewer(m, bare.memory.id, support.memory.id);

    const v = await m.sourceMonitor('ZZREL7 the failover window is ninety seconds', { scope: 'region=us-east' });
    assert.equal(v.stale_support, true);
    assert.ok(v.newer_related.length > 0, 'the newer trace is the cause');
    assert.equal(v.superseded_matches.length, 0, 'and no archive chain is involved');
    assert.match(String(v.note), /newer_related/, `the note must point at the populated list: ${v.note}`);
    assert.match(String(v.note), /NEWER trace exists/, 'the established wording survives for its own cause');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
