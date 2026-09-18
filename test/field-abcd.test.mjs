/**
 * Field report rounds 7-8 (BUG-A/B/C/D, STAR, verify hardening).
 *
 *  A: `merge` exists but fires only for a cross-kind verbatim restatement
 *     (episode restates a semantic rule word-for-word). Same-kind writes
 *     never merge by design — rehearsal (`none`) / override own those
 *     shapes. Pins the trigger and the now-consistent return shape.
 *  B: identical summaries with different `detail` collapsed to `none` and
 *     the second detail was silently dropped. Detail is part of the claim:
 *     a differing detail must not rehearse.
 *  C: `sourceMonitor` labelled unrelated rows "assert the OPPOSITE" on
 *     polarity alone among loosely related rows. Contradiction now needs a
 *     shared entity with the support row plus a real disagreement (round 8:
 *     same-subject-alone also leaks via prose-derived subjects).
 *  D: `scope_only_matches` is present on every outcome (possibly empty).
 *  STAR: entity-less value flips never overrode (no shared entity possible).
 *     Explicit arrows on both entity-less sides clearing the contradiction
 *     bar now override (path-0b); anything still withheld warns instead of
 *     staying silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'abcd', options) {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), ...(options ? { options } : {}) });
  return { m, dir };
}

test('BUG-B: same summary but different detail is NOT a rehearsal', async () => {
  const { m, dir } = freshStore('b');
  try {
    const first = await m.remember({
      kind: 'semantic',
      summary: 'ZZDETAIL1 KAPPA-1 record',
      detail: 'DETAIL-MARKER-ALPHA-1111',
      entities: [{ name: 'kappa' }]
    });
    assert.equal(first.outcome, 'new');
    const second = await m.remember({
      kind: 'semantic',
      summary: 'ZZDETAIL1 KAPPA-1 record',
      detail: 'DETAIL-MARKER-BETA-2222',
      entities: [{ name: 'kappa' }]
    });
    assert.notEqual(second.outcome, 'none', `differing detail must not rehearse: ${second.outcome}`);
    assert.equal(m.stats().active, 2, 'both details must survive as live rows');
    const rec = await m.recall({ query: 'ZZDETAIL1 KAPPA-1' }, 5);
    const details = rec.hits.map((h) => h.detail ?? null);
    assert.ok(details.includes('DETAIL-MARKER-ALPHA-1111'), `ALPHA retrievable: ${JSON.stringify(details)}`);
    assert.ok(details.includes('DETAIL-MARKER-BETA-2222'), `BETA retrievable: ${JSON.stringify(details)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-B: same subject+value with new detail versions instead of rehearsing', async () => {
  const { m, dir } = freshStore('b2');
  try {
    const first = await m.remember({
      kind: 'semantic',
      summary: 'cache policy -> strict',
      detail: 'decided monday',
      entities: [{ name: 'cache' }]
    });
    assert.equal(first.outcome, 'new');
    const second = await m.remember({
      kind: 'semantic',
      summary: 'cache policy -> strict',
      detail: 'reconfirmed friday with metrics',
      entities: [{ name: 'cache' }]
    });
    assert.notEqual(second.outcome, 'none', `new detail must not be a silent rehearsal: ${second.outcome}`);
    assert.equal(second.memory.detail, 'reconfirmed friday with metrics');
    if (second.outcome === 'override') {
      const hist = m.history(second.memory.id);
      assert.ok(
        hist.some((h) => h.detail === 'decided monday'),
        `old detail archived in history: ${JSON.stringify(hist)}`
      );
    } else {
      // Neutral rewrite below the contradiction bar: kept as a sibling row.
      assert.equal(second.outcome, 'new');
      assert.equal(m.stats().active, 2, 'both details survive as live rows');
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-B: identical restatement (same detail) still rehearses', async () => {
  const { m, dir } = freshStore('b3');
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZDETAIL1 KAPPA-1 record',
      detail: 'DETAIL-MARKER-ALPHA-1111',
      entities: [{ name: 'kappa' }]
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'ZZDETAIL1 KAPPA-1 record',
      detail: 'DETAIL-MARKER-ALPHA-1111',
      entities: [{ name: 'kappa' }]
    });
    assert.equal(second.outcome, 'none', 'byte-identical restatement must still rehearse');
    assert.equal(m.stats().active, 1);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-A: episode restating a semantic rule merges; same-kind restates do not', async () => {
  const { m, dir } = freshStore('a');
  try {
    await m.remember({ kind: 'semantic', summary: 'the cache holds tokens', entities: [{ name: 'cache' }] });
    const merged = await m.remember({
      kind: 'episode',
      summary: 'the cache holds tokens',
      entities: [{ name: 'cache' }]
    });
    assert.equal(merged.outcome, 'merge', `verbatim cross-kind restatement merges: ${merged.outcome}`);
    assert.ok(Array.isArray(merged.scope_only_matches), 'merge carries scope_only_matches');
    assert.ok(Array.isArray(merged.neighbours), 'merge carries neighbours');
    assert.equal(m.stats().active, 1, 'merge folds into the existing row');

    const s1 = await m.remember({ kind: 'semantic', summary: 'merge probe alpha', entities: [{ name: 'probe' }] });
    const s2 = await m.remember({ kind: 'semantic', summary: 'merge probe alpha', entities: [{ name: 'probe' }] });
    assert.equal(s1.outcome, 'new');
    assert.equal(s2.outcome, 'none', 'same-kind restatement rehearses, never merges');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G5: FACT:-wrapped episode with rule merges deterministically (no cosine gate)', async () => {
  const { m, dir } = freshStore('g5');
  const body = 'the build cache holds tokens for offline installs';
  try {
    await m.remember({ kind: 'semantic', summary: body, semantic: { rule: body }, entities: [{ name: 'cache' }] });
    const merged = await m.remember({ kind: 'episode', summary: `FACT: ${body}`, entities: [{ name: 'cache' }] });
    assert.equal(merged.outcome, 'merge', `wrapped restatement merges: ${merged.outcome}`);
    assert.equal(m.stats().active, 1);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G5: same body with extra detail or different entities stays its own trace', async () => {
  const body = 'the build cache holds tokens for offline installs';
  const { m, dir } = freshStore('g5b');
  try {
    await m.remember({ kind: 'semantic', summary: body, entities: [{ name: 'cache' }] });
    const withDetail = await m.remember({
      kind: 'episode', summary: body, detail: 'observed during tuesday rollout',
      entities: [{ name: 'cache' }]
    });
    assert.equal(withDetail.outcome, 'new', `episode carrying its own detail must survive: ${withDetail.outcome}`);
    const otherScope = await m.remember({ kind: 'episode', summary: body, entities: [{ name: 'mirror' }] });
    assert.equal(otherScope.outcome, 'new', `different entity set must survive: ${otherScope.outcome}`);
    assert.equal(m.stats().active, 3, 'no information folded away');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct-DB callers may pass entities as plain strings', async () => {
  const { m, dir } = freshStore('strent');
  try {
    const w = await m.remember({ kind: 'semantic', summary: 'string entity probe -> ok', entities: ['probe'] });
    assert.equal(w.outcome, 'new');
    assert.deepEqual(w.memory.entities, ['probe']);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-C: unrelated rows are not labelled OPPOSITE', async () => {
  // Lowered floor simulates a production embedder's higher absolute cosines:
  // the rows below clear it on similarity alone, so the test pins the gate,
  // not the threshold.
  const { m, dir } = freshStore('c', { similarityThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'pigcore blob capture does not store raw bytes here', entities: [{ name: 'pigcore-blob' }] });
    await m.remember({ kind: 'semantic', summary: 'pigcore TBL runtime read path never uses cache here', entities: [{ name: 'pigcore-tbl' }] });
    await m.remember({ kind: 'semantic', summary: 'ZZDETAIL1 KAPPA-1 record', detail: 'DETAIL-MARKER-BETA-2222', entities: [{ name: 'kappa' }] });
    const v = await m.sourceMonitor('ZZDETAIL1 requires DETAIL-MARKER-BETA-2222');
    assert.equal(v.substantiated, true);
    assert.equal(v.contradicting.length, 0, `unrelated rows must not contradict: ${JSON.stringify(v.contradicting)}`);
    assert.ok(!v.note.includes('OPPOSITE'), `no false OPPOSITE warning: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-C: same-scope opposite polarity still contradicts', async () => {
  const { m, dir } = freshStore('c2', { similarityThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'the gateway runs nginx', entities: [{ name: 'gateway' }] });
    await m.remember({ kind: 'semantic', summary: 'the gateway does not run nginx', entities: [{ name: 'gateway' }] });
    const v = await m.sourceMonitor('the gateway runs nginx');
    assert.ok(
      v.contradicting.some((c) => c.summary.includes('does not run nginx')),
      `same-scope negation must contradict: ${JSON.stringify(v.contradicting)}`
    );
    assert.ok(v.note.includes('OPPOSITE'), 'true contradiction keeps the OPPOSITE warning');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-D: scope_only_matches present on every outcome', async () => {
  const { m, dir } = freshStore('d');
  try {
    const r1 = await m.remember({ kind: 'semantic', summary: 'scope probe one', entities: [{ name: 'ent-a' }] });
    assert.ok(Array.isArray(r1.scope_only_matches), 'new carries the key');
    const r2 = await m.remember({ kind: 'semantic', summary: 'scope probe one', entities: [{ name: 'ent-a' }] });
    assert.equal(r2.outcome, 'none');
    assert.ok(Array.isArray(r2.scope_only_matches), 'none carries the key');
    const r3 = await m.remember({
      kind: 'semantic',
      summary: 'scope probe one',
      entities: [{ name: 'ent-a' }],
      supersedes: [r1.memory.id]
    });
    assert.equal(r3.outcome, 'supersede');
    assert.ok(Array.isArray(r3.scope_only_matches), 'supersede carries the key');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STAR: withheld entity-less update warns instead of staying silent', async () => {
  const { m, dir } = freshStore('star');
  try {
    await m.remember({ kind: 'semantic', summary: 'cache slot -> RHO-1000' });
    const second = await m.remember({ kind: 'semantic', summary: 'cache slot -> CHI-3000' });
    // Hashing sim (0.47) is below the contradiction bar, so this stays new —
    // but the caller must be told what was seen and withheld.
    assert.equal(second.outcome, 'new');
    assert.ok(second.scope_only_matches?.length, 'withheld row surfaced');
    assert.ok(
      second.warning && second.warning.startsWith('not-overridden:') && second.warning.includes('supersedes'),
      `blocked update warns with recourse: ${second.warning}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STAR: entity-less arrow flip stays new even over the bar (deliberate gate)', async () => {
  // Retraction accepted: "no entities declared" never counts as shared scope
  // (BUG-1 (b)). Even with a lowered bar simulating a production embedder,
  // an entity-less value flip must not override — but it must warn.
  const { m, dir } = freshStore('star2', { contradictionThreshold: 0.4 });
  try {
    const first = await m.remember({ kind: 'semantic', summary: 'cache slot -> RHO-1000' });
    assert.equal(first.outcome, 'new');
    const second = await m.remember({ kind: 'semantic', summary: 'cache slot -> CHI-3000' });
    assert.equal(second.outcome, 'new', `entity-less flip stays a new trace: ${second.outcome}`);
    assert.ok(second.warning && second.warning.startsWith('not-overridden:'), `blocked update warns: ${second.warning}`);
    assert.equal(m.stats().active, 2, 'both rows survive');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STAR: entity-less PROSE flip never takes the arrow path', async () => {
  // BUG-1 (a) guard: prose-derived subjects collide between unrelated
  // sentences, so they must not override even over the bar.
  const { m, dir } = freshStore('star3', { contradictionThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'the meeting room booking is handled two days ahead' });
    const second = await m.remember({ kind: 'semantic', summary: 'the meeting room booking is managed by the facilities team' });
    assert.equal(second.outcome, 'new', `prose collision must not override: ${second.outcome}`);
    assert.ok(second.warning && second.warning.startsWith('not-overridden:'), 'but it still warns');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-C round 8: entity-disjoint rows never contradict, even sharing a prose subject', async () => {
  // Same noun phrase ("the deploy cache") in two different scopes: the old
  // gate flagged this as OPPOSITE on subject + polarity alone.
  const { m, dir } = freshStore('c3', { similarityThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'the deploy cache is warm', entities: [{ name: 'deploy-cache' }] });
    await m.remember({ kind: 'semantic', summary: 'the deploy cache is not serving staging traffic', entities: [{ name: 'staging-cache' }] });
    const v = await m.sourceMonitor('the deploy cache is warm');
    assert.equal(v.contradicting.length, 0, `entity-disjoint row must not contradict: ${JSON.stringify(v.contradicting)}`);
    assert.ok(!v.note.includes('OPPOSITE'), `no false OPPOSITE warning: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R31: detail-dominated match does not override (dual-similarity gate)', async () => {
  // Same shape as the live false positive: shared long detail pushes the
  // contentText cosine over the bar while the claims themselves diverge.
  // Lowered bar simulates a production embedder's absolute scale.
  const shared = 'R30 work covered node whitelist plus digest stripping plus human word coverage measurement baseline checks';
  const { m, dir } = freshStore('r31', { contradictionThreshold: 0.5 });
  try {
    await m.remember({ kind: 'semantic', summary: 'alpha weekly report notes steady state', detail: shared, entities: [{ name: 'x' }] });
    const second = await m.remember({ kind: 'semantic', summary: 'beta review found no anomalies closed', detail: shared, entities: [{ name: 'x' }] });
    assert.equal(second.outcome, 'new', `detail-dominated pair must not override: ${second.outcome}`);
    assert.ok(second.warning && second.warning.startsWith('withheld-contradiction:'), `withheld names both calibres: ${second.warning}`);
    assert.ok(second.warning.includes('content-sim') && second.warning.includes('claim-sim'), 'both similarities printed');
    assert.equal(m.stats().active, 2, 'both claims survive');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R31 control: true negation still overrides and prints both similarities', async () => {
  const { m, dir } = freshStore('r31c', { contradictionThreshold: 0.5 });
  try {
    await m.remember({ kind: 'semantic', summary: 'cache holds tokens', entities: [{ name: 'cache' }] });
    const second = await m.remember({ kind: 'semantic', summary: 'cache holds no tokens', entities: [{ name: 'cache' }] });
    assert.equal(second.outcome, 'override', `true negation must still version: ${second.outcome}`);
    assert.ok(second.warning && second.warning.includes('content-sim') && second.warning.includes('claim-sim'), `warning prints both: ${second.warning}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
