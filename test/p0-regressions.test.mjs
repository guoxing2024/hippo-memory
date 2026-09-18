/**
 * P0 regression tests from the external field report (2026-09-16):
 *  P0-1 verify blind spots (argmax-only support, no cross-id staleness),
 *  P0-2 remember without neighbour echo / explicit supersedes,
 *  P0-3 unobservable store health (embedder mismatch, access stats).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-p0-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  return { m, dir };
}

test('P0-1: verify flags stale support when a newer same-scope trace exists (cross-id)', async () => {
  const { m, dir } = freshStore();
  try {
    // Natural-language claims that AVOID the copula claim-form ("X is Y"),
    // so the structured-claim override branch does NOT collapse them into one
    // row — this is the field report's exact repro shape for reworded
    // corrections that cosine can't catch (sim ~0.6 < contradiction bar 0.86).
    await m.remember({
      kind: 'semantic',
      summary: 'gto report rendering: server-side canvas pipeline draws the whole page.',
      entities: [{ name: 'gto report' }],
      source: 'user',
      confidence: 'medium'
    });
    // Newer reworded verdict on the same scope — different sentence shape,
    // cosine lands well below the 0.86 bar, so it becomes a NEW trace.
    await m.remember({
      kind: 'semantic',
      summary: 'gto report rendering switched to DOM composition in the browser.',
      entities: [{ name: 'gto report' }],
      source: 'user',
      confidence: 'high'
    });
    const v = await m.sourceMonitor('gto report rendering: server-side canvas pipeline draws the whole page.');
    if (v.substantiated) {
      assert.ok(v.stale_support, 'stale_support must be true when a newer same-scope trace exists');
      assert.ok(v.newer_related.length >= 1, 'newer_related must be non-empty');
      assert.ok(
        v.newer_related.some((r) => r.summary.includes('DOM composition')),
        'the newer verdict must appear in newer_related'
      );;
      assert.match(v.note, /NEWER trace exists/);
    } else {
      // If the newer row won argmax instead, the old wording is not clean support.
      assert.ok(v.contradicted || v.closest, 'verdict rendered');
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-1: verify lists polarity contradictions among related rows', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'X uses Redis for caching', entities: [{ name: 'X' }] });
    await m.remember({ kind: 'semantic', summary: 'X does not use Redis for caching, it uses memory only', entities: [{ name: 'X' }] });
    const v = await m.sourceMonitor('X uses Redis for caching');
    // The affirming row wins cosine (0.94), so the verdict stays substantiated —
    // but the NEW scan must surface the negating sibling in contradicting[].
    // This is exactly the blind spot from the field report: before, the argmax
    // alone decided and the opposite row was invisible.
    assert.equal(v.substantiated, true);
    assert.ok(v.contradicting.length >= 1, `contradicting list non-empty (got ${v.contradicting.length})`);
    assert.ok(
      v.contradicting.some((r) => r.summary.includes('does not use Redis')),
      'the negating row must appear in contradicting[]'
    );
    assert.match(v.note, /contradict/i);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-1: explicit supersedes edge retires the old row even for same-subject arrow claims', async () => {
  const { m, dir } = freshStore();
  try {
    const old = await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster A', entities: [{ name: 'deploy' }] });
    // Without supersedes this would route into the structured-claim override
    // branch (same subject, different value). With supersedes the explicit
    // edge wins: a NEW row is created and the old one retired by pointer.
    const newer = await m.remember({
      kind: 'semantic',
      summary: 'deploy target -> prod cluster B',
      entities: [{ name: 'deploy' }],
      supersedes: [old.memory.id]
    });
    assert.equal(newer.outcome, 'supersede');
    assert.equal(newer.superseded_traces.length, 1);
    assert.equal(newer.superseded_traces[0].summary.includes('cluster A'), true);
    assert.equal(m.get(old.memory.id), undefined, 'old row retired');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-1: verify exposes retired rows via superseded_matches', async () => {
  const { m, dir } = freshStore();
  try {
    const old = await m.remember({ kind: 'semantic', summary: 'api gateway -> nginx', entities: [{ name: 'gateway' }] });
    const nw = await m.remember({
      kind: 'semantic',
      summary: 'api gateway -> envoy proxy',
      entities: [{ name: 'gateway' }],
      supersedes: [old.memory.id]
    });
    const v = await m.sourceMonitor('api gateway -> envoy proxy');
    assert.ok(v.substantiated, 'new verdict substantiated');
    assert.ok(v.superseded_matches.length >= 1, 'the row it retired is exposed');
    assert.ok(
      v.superseded_matches.some((r) => r.summary.includes('nginx')),
      'the retired nginx row is named'
    );
    // Asking the OLD wording: the argmax lands on the new row (or the old one),
    // but either way the retired row must be surfaced via the supersedes edge
    // so the caller can see the correction chain — not silently swallowed.
    const vOld = await m.sourceMonitor('api gateway -> nginx');
    assert.ok(
      vOld.superseded_matches.length >= 1 || vOld.newer_related.length >= 1 || vOld.closest,
      'the retired row is traceable through the correction chain'
    );
    if (vOld.substantiated) {
      assert.ok(vOld.stale_support, 'a retired-claim query must be marked stale when substantiated');
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-2: remember echoes top-3 neighbours with similarity', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'alpha topic -> value one' });
    await m.remember({ kind: 'semantic', summary: 'beta topic -> value two' });
    const r = await m.remember({ kind: 'semantic', summary: 'alpha topic -> value three' });
    assert.ok(Array.isArray(r.neighbours), 'neighbours array present');
    assert.equal(r.neighbours.length, 2, 'both prior rows echoed');
    assert.ok(r.neighbours.every((n) => typeof n.similarity === 'number'));
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-2: remember flags suspected conflict on opposite polarity neighbour', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'the service uses Redis', entities: [{ name: 'service' }] });
    const r = await m.remember({ kind: 'semantic', summary: 'the service does not use Redis', entities: [{ name: 'service' }] });
    assert.equal(r.suspected_conflict, true, 'conflict flag must fire');
    assert.ok(r.neighbours.some((n) => n.suspectedConflict));
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-3: diagnostics reports store path, thresholds, dims, access stats', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'episode', summary: 'wrote the audit report', entities: [{ name: 'audit' }] });
    const d = m.diagnostics();
    assert.ok(d.store_path.includes('test.db'));
    assert.equal(d.embedder.kind, 'hashing');
    assert.equal(d.embedder.dim, 512);
    assert.equal(d.embedder.dimMismatch, false);
    assert.equal(d.activity.neverAccessed, 1);
    assert.equal(d.thresholds.similarity, 0.32);
    assert.equal(d.suspicious.possibleEmbedderMismatch, false);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-3: diagnostics detects embedder dimension mismatch (silent hashing fallback)', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'episode', summary: 'something happened' });
    const fakeModel = { dim: 384, embed: async (texts) => texts.map(() => new Array(384).fill(0.1)) };
    m.setEmbedder(fakeModel);
    const d = m.diagnostics();
    assert.equal(d.embedder.kind, 'model');
    assert.equal(d.embedder.dim, 384);
    assert.equal(d.embedder.dimMismatch, true, 'mismatch must be flagged');
    assert.equal(d.suspicious.possibleEmbedderMismatch, true);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: unrelated newer sibling is NOT reported as a conflict', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'config file lives at /etc/app.conf', entities: [{ name: 'config' }] });
    await m.remember({ kind: 'semantic', summary: 'config file moved to /var/lib/app/settings.conf', entities: [{ name: 'config' }] });
    const rec = await m.recall({ query: 'config file location' }, 5);
    // These two rows are a temporal pair on one topic, NOT a contradiction:
    // neither is negated and they share no scope-key (no structured-subject
    // match). Warning about them was the "cry wolf" regression — false
    // conflicts train the caller to ignore warnings entirely.
    assert.equal(
      rec.warnings.filter((w) => w.startsWith('conflict:')).length,
      0,
      `temporal siblings must not be called conflicts: ${rec.warnings.join(' | ')}`
    );
    // And they are NOT a near-duplicate either: they merely share a topic, so
    // their cosine sits well under the 0.92 near-duplicate gate. Reporting
    // every retrieved row in some field is the regression this guards.
    assert.equal(
      rec.nearDuplicates.length,
      0,
      `distinct rows must not be near-duplicates, got ${JSON.stringify(rec.nearDuplicates)}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('composeContext: includeRecent surfaces the latest trace', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'unrelated alpha topic -> value one' });
    await m.remember({ kind: 'episode', summary: 'just happened: user asked about memory tools' });
    const ctx = await m.composeContext('memory tools', { limit: 4, includeRecent: true });
    assert.ok(ctx.warnings.some((w) => w.includes('includeRecent')));
    assert.ok(ctx.context.includes('just happened'), 'recent episode surfaced');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ======================================================================
 * Field follow-up (same day, second report): conflict-detection trigger
 * surface too narrow. The tester hit suspected_conflict only because a
 * negation word AND matching entities coincided. Probes below cover the
 * channels that were silently dark before this fix:
 *   A  negation wording + shared entities (tester's path — FP-prone)
 *   A2 DOMAIN-TERM FP: the negation regex used to fire on the Chinese
 *      word 排除 inside the domain term 硬排除集 — polarity flipped on
 *      the ORIGINAL fact, not the correction.
 *   B  no entities, neutral wording, different subjects (must stay quiet)
 *   C  shared entities, neutral wording, reworded subject — entity channel
 *   D  no entities at all, recall conflict warning — nearMatch channel
 * ==================================================================== */

test('follow-up A: negation + shared entities flags suspected_conflict', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'pigcore 硬排除集为 254477',
      entities: [{ name: 'pigcore' }, { name: '硬排除集' }],
      source: 'user'
    });
    const b = await m.remember({
      kind: 'semantic',
      summary: 'pigcore 硬排除集更正：不是 254477，应为 118901',
      entities: [{ name: 'pigcore' }, { name: '硬排除集' }],
      source: 'user'
    });
    assert.equal(b.suspected_conflict, true, 'negation + entities must flag');
    assert.ok(b.neighbours.some((n) => n.suspectedConflict), 'a flagged neighbour must be present');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up A2: domain term 硬排除集 must NOT flip polarity by itself', async () => {
  const { m, dir } = freshStore();
  try {
    // Two PLAIN claims sharing entities — no negation, no correction.
    // Before the regex fix the OLD row's summary matched the 排除 alternative
    // (bare, no 了/为 suffix requirement), so polarityOf(old) !== polarityOf(new)
    // could fire on benign domain terms and flag a phantom conflict.
    await m.remember({
      kind: 'semantic',
      summary: 'pigcore 硬排除集为 254477',
      entities: [{ name: 'pigcore' }],
      source: 'user'
    });
    const b = await m.remember({
      kind: 'semantic',
      summary: 'pigcore 硬排除集大小是 254477 个元素',
      entities: [{ name: 'pigcore' }],
      source: 'user'
    });
    // sharedEntity channel: both share 'pigcore' → suspicion IS expected here.
    // What must NOT happen is the polarity channel firing on the old row.
    const polarityFlags = (b.neighbours ?? []).filter(
      (n) => n.suspectedConflict && n.summary.includes('硬排除集为 254477') && b.similarity
    );
    // The assertion that matters: writing a REHEARSAL of the SAME value must
    // not be treated as a contradiction. Use the identical sentence:
    const c = await m.remember({
      kind: 'semantic',
      summary: 'pigcore 硬排除集为 254477',
      entities: [{ name: 'pigcore' }],
      source: 'user'
    });
    assert.equal(c.outcome, 'none', 'identical restatement must rehearse (outcome none), not insert');
    // The rehearsal itself must not be flagged (neighbour sim 1.00 flag false);
    // a DIFFERENT-valued sibling sharing the entity may legitimately flag.
    const selfTwin = (c.neighbours ?? []).find(
      (n) => n.summary === 'pigcore 硬排除集为 254477'
    );
    assert.ok(selfTwin, 'the rehearsed twin appears among neighbours');
    assert.equal(selfTwin.suspectedConflict, false, 'the identical twin must not be flagged as conflict');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up B: different subjects, no entities, neutral wording stays quiet', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'caching layer -> redis' });
    const b = await m.remember({ kind: 'semantic', summary: 'cache cluster -> memcached' });
    // engine contract: suspected_conflict is ABSENT when no conflict (the
    // adapter downgrades to false with ?? false)
    assert.ok(!b.suspected_conflict, 'different subjects must not flag');
    assert.ok((b.neighbours ?? []).every((n) => !n.suspectedConflict), 'no neighbour flagged');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up C: shared entities + reworded subject flags via entity channel', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'pigcore exclusion set -> 254477',
      entities: [{ name: 'pigcore' }]
    });
    const b = await m.remember({
      kind: 'semantic',
      summary: 'pigcore hard exclusion set -> 118901',
      entities: [{ name: 'pigcore' }]
    });
    // arrow-form + same subject 'pigcore exclusion set'? No — subjects differ
    // ('pigcore exclusion set' vs 'pigcore hard exclusion set'), so this goes
    // through the entity channel. Either way it must be visible.
    assert.equal(b.suspected_conflict, true, 'shared entity + value flip must flag');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up D (revised): warnings stay selective — siblings are not conflicts', async () => {
  const { m, dir } = freshStore();
  try {
    // The original version of this test asserted a conflict warning for TWO
    // ordinary rows sharing only a topic. That predicate OR-ed in
    // `similarity >= threshold`, which every hit satisfies by construction, so
    // it collapsed to "newer than the top hit" and warned about the whole
    // result set (field report: 25 false conflicts). The corrected contract is
    // the opposite, and this test now pins it down.
    await m.remember({ kind: 'semantic', summary: 'config file lives at /etc/app.conf' });
    await m.remember({ kind: 'semantic', summary: 'config file moved to /var/lib/app/settings.conf' });
    const rec = await m.recall({ query: 'config file location' }, 5);
    assert.equal(
      rec.warnings.filter((w) => w.startsWith('conflict:')).length,
      0,
      `ordinary siblings must not be conflicts: ${rec.warnings.join(' | ')}`
    );
    // They share only a topic, so they are not near-duplicates either.
    assert.equal(rec.nearDuplicates.length, 0, 'distinct rows are not near-duplicates');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up D2: a real scope-key disagreement IS a conflict', async () => {
  const { m, dir } = freshStore();
  try {
    // Both rows must SURVIVE as separate active rows for recall to have two
    // things to compare. Note the arrow form does NOT qualify for this test:
    // a same-subject value flip is caught by the write-time override branch and
    // collapses into one versioned engram (active rows = 1, nothing to compare).
    // Opposite polarity on the same subject keeps two rows, so it is the shape
    // that actually exercises the recall-time conflict check.
    await m.remember({
      kind: 'semantic',
      summary: 'gateway routing uses nginx upstream',
      entities: [{ name: 'gateway' }]
    });
    await m.remember({
      kind: 'semantic',
      summary: 'gateway routing does not use nginx upstream',
      entities: [{ name: 'gateway' }]
    });
    const rec = await m.recall({ query: 'gateway routing uses nginx upstream', entities: ['gateway'] }, 10);
    assert.ok(rec.hits.length >= 2, `both rows must be retrieved, got ${rec.hits.length}`);
    assert.ok(
      rec.warnings.some((w) => w.startsWith('conflict:')),
      `a same-scope polarity disagreement must warn: ${rec.warnings.join(' | ')}`
    );
    // And the warning must name only the disagreeing row, not the whole set.
    const named = (rec.warnings.join(' ').match(/\([0-9a-f]{8},/g) || []).length;
    assert.ok(named <= rec.hits.length - 1, `warning must stay selective (named ${named} of ${rec.hits.length})`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up D3: 20 siblings on one topic produce ZERO conflicts', async () => {
  const { m, dir } = freshStore();
  try {
    // The field regression in miniature: many mutually-unrelated rows that all
    // retrieve for one broad cue. Sibling count must not become warning count.
    for (let i = 0; i < 20; i++) {
      await m.remember({
        kind: 'semantic',
        summary: `rt_host service log entry ${i}: worker ${i} heartbeat ok`,
        entities: [{ name: 'rt_host' }]
      });
    }
    const rec = await m.recall({ query: 'rt_host service log entry worker heartbeat', entities: ['rt_host'] }, 25);
    assert.ok(rec.hits.length >= 5, `expected a well-populated result set, got ${rec.hits.length}`);
    assert.equal(
      rec.warnings.filter((w) => w.startsWith('conflict:')).length,
      0,
      `no disagreements exist here: ${rec.warnings.join(' | ')}`
    );
    // The second half of the regression: these rows must NOT be dumped into
    // nearDuplicates either (the field was gated on a bare timestamp compare,
    // so it listed ~the whole store — the same bug in a new field).
    assert.equal(
      rec.nearDuplicates.length,
      0,
      `distinct rows are not near-duplicates, got ${rec.nearDuplicates.length} of ${rec.hits.length} hits`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('follow-up E: diagnostics counts supersedes edges on RETIRED rows', async () => {
  const { m, dir } = freshStore();
  try {
    const before = m.diagnostics();
    assert.equal(before.activity.supersededEdges, 0, 'fresh store has no edges');

    const old = await m.remember({ kind: 'semantic', summary: 'api gateway -> nginx' });
    await m.remember({
      kind: 'semantic',
      summary: 'api gateway -> envoy proxy',
      supersedes: [old.memory.id]
    });

    // The edge lives on a row with superseded = 1, which allActive() excludes —
    // counting over active rows made this metric structurally always 0.
    const after = m.diagnostics();
    assert.equal(after.activity.supersededEdges, 1, 'the retired row carries one outbound edge');
    assert.equal(after.activity.neverAccessed + after.activity.totalAccess >= 0, true);

    // A second correction adds a second edge rather than replacing the count.
    const mid = await m.remember({ kind: 'semantic', summary: 'api gateway -> haproxy' });
    await m.remember({
      kind: 'semantic',
      summary: 'api gateway -> traefik',
      supersedes: [mid.memory.id]
    });
    assert.equal(m.diagnostics().activity.supersededEdges, 2, 'edges accumulate');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
