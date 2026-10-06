/**
 * What makes a recall hit an answer rather than a vector neighbour.
 *
 * Cosine is compressed and query-dependent, so `relativeScore` (sim ÷ best sim)
 * reads as confidence even for a row that shares not one identifier, entity,
 * claim subject or word with the cue. This suite pins the anchor signal — the
 * nameable evidence tying a hit to the cue — and the digest gate that keeps
 * unanchored neighbours out of the injected context while an anchored row is
 * available.
 *
 * Deliberately NOT changed here: the 0.32 similarity floor and the relativeScore
 * formula. Both are pinned by the last test so the belt cannot smuggle in a
 * threshold change (the field report asked for the misleading reading to be
 * labelled, not for the numbers to be moved).
 *
 * The embedder below is a stand-in for a real model: it maps topic words to
 * fixed vectors so two rows can sit ~0.99 apart in vector space while sharing no
 * vocabulary — the exact shape the hashing embedder cannot produce, and the one
 * a semantic model produces constantly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

/** postgres ≈ the cue; mysql/kafka are near it without sharing a word with it. */
function anchorEmbedder() {
  const table = [
    ['postgres', [1, 0, 0]],
    ['mysql', [0.9987, 0.05116, 0]],
    ['kafka', [0.9, 0, 0]],
    ['uptime', [0.7, 0.71414, 0]]
  ];
  return {
    dim: 3,
    embed: async (texts) =>
      texts.map((t) => {
        const hit = table.find(([word]) => t.includes(word));
        return hit ? hit[1] : [0, 1, 0]; // unrelated text: orthogonal to the cue
      })
  };
}

function anchorStore(tag = 'anchor') {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), similarityThreshold: 0.05 });
  m.setEmbedder(anchorEmbedder());
  return { m, dir };
}

const CUE = 'ZZQ1 postgres replica failover lag';

test('ZZANC1 anchor: a hit with no shared identifier, entity, subject or word is flagged unanchored', async () => {
  const { m, dir } = anchorStore();
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZA1 the mysql credentials rotate every Tuesday',
      entities: [{ name: 'mysql' }],
      importance: 0.8
    });
    assert.equal(m.stats().active, 1, 'the fixture is its own trace');
    const rec = await m.recall({ query: CUE });
    assert.equal(rec.hits.length, 1, `vector proximity alone makes this a hit: ${JSON.stringify(rec.nearMisses)}`);
    assert.ok(rec.hits[0].similarity > 0.99, `fixture must be close in space: ${rec.hits[0].similarity}`);
    assert.equal(rec.hits[0].anchored, false, `nothing names the cue: ${JSON.stringify(rec.hits[0].anchors)}`);
    assert.deepEqual(rec.hits[0].anchors, []);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC2 anchor: a shared identifier anchors the hit', async () => {
  const { m, dir } = anchorStore('anchor-id');
  try {
    await m.remember({
      kind: 'episode',
      summary: 'ZZA2 the mysql gate accepted 0x212aa5 after the reboot',
      entities: [{ name: 'mysql' }]
    });
    const rec = await m.recall({ query: 'ZZQ2 postgres 0x212aa5' });
    assert.equal(rec.hits.length, 1, 'the row is a hit');
    assert.equal(rec.hits[0].anchored, true);
    assert.ok(rec.hits[0].anchors.includes('identifier'), `tiers: ${JSON.stringify(rec.hits[0].anchors)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC3 anchor: an entity named by the cue anchors the hit', async () => {
  const { m, dir } = anchorStore('anchor-ent');
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZA3 mysql sizing for the payments ledger',
      entities: [{ name: 'payments' }]
    });
    const rec = await m.recall({ query: 'ZZQ3 postgres payments' });
    assert.equal(rec.hits.length, 1, 'the row is a hit');
    assert.equal(rec.hits[0].anchored, true);
    assert.ok(rec.hits[0].anchors.includes('entity'), `tiers: ${JSON.stringify(rec.hits[0].anchors)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC4 anchor: the subject of a structured claim anchors the hit', async () => {
  const { m, dir } = anchorStore('anchor-subj');
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZA4 mysql canary window is one hour' });
    const rec = await m.recall({ query: 'ZZQ4 postgres canary window' });
    assert.equal(rec.hits.length, 1, 'the row is a hit');
    assert.equal(rec.hits[0].anchored, true);
    assert.ok(rec.hits[0].anchors.includes('subject'), `tiers: ${JSON.stringify(rec.hits[0].anchors)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC5 anchor: one shared content word is enough to count as anchored', async () => {
  const { m, dir } = anchorStore('anchor-word');
  try {
    // "monthly" is shared but sits in the PREDICATE, so this pins the weakest
    // tier alone — the subject of the claim is not what the cue named.
    await m.remember({ kind: 'semantic', summary: 'ZZA5 mysql canary window is reviewed monthly' });
    const rec = await m.recall({ query: 'ZZQ5 postgres monthly' });
    assert.equal(rec.hits.length, 1, 'the row is a hit');
    assert.equal(rec.hits[0].anchored, true, 'weak but nameable: err toward "not noise"');
    assert.deepEqual(rec.hits[0].anchors, ['vocabulary'], `tiers: ${JSON.stringify(rec.hits[0].anchors)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC6 digest: unanchored hits stay out of the injected block when an anchored one exists', async () => {
  const { m, dir } = anchorStore('anchor-digest');
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZA6 the mysql credentials rotate every Tuesday',
      entities: [{ name: 'mysql' }]
    });
    const anchored = await m.remember({
      kind: 'episode',
      summary: 'ZZA7 postgres replica lag alarm fired twice',
      entities: [{ name: 'postgres' }]
    });
    assert.equal(m.stats().active, 2, 'both traces are stored');
    const rec = await m.recall({ query: CUE });
    assert.equal(rec.hits.length, 2, 'recall itself keeps both — the flag is on the item, not a deletion');

    const ctx = await m.composeContext(CUE);
    assert.deepEqual(ctx.items.map((i) => i.id), [anchored.memory.id], 'only the anchored row is injected');
    assert.match(ctx.context, /ZZA7/, 'the anchored row renders');
    assert.ok(!ctx.context.includes('credentials'), `unanchored row withheld:\n${ctx.context}`);
    assert.ok(
      ctx.warnings.some((w) => /unanchored/i.test(w) && /ZZA6|credentials/.test(w)),
      `the warning names what was dropped: ${ctx.warnings}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC7 digest: when nothing is anchored the block still renders — degrade, never starve', async () => {
  const { m, dir } = anchorStore('anchor-starve');
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'ZZA8 the mysql credentials rotate every Tuesday',
      entities: [{ name: 'mysql' }]
    });
    const ctx = await m.composeContext(CUE);
    assert.equal(ctx.items.length, 1, 'the only thing available is still better than silence');
    assert.match(ctx.context, /ZZA8/);
    assert.ok(
      ctx.warnings.some((w) => /unanchored|vector/i.test(w)),
      `and the caller is told its standing: ${ctx.warnings}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC9 anchor: the empty-cue and recency paths carry the field too', async () => {
  const { m, dir } = anchorStore('anchor-empty');
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZA9 mysql uptime is reviewed quarterly' });
    const rec = await m.recall({ query: '   ' });
    assert.equal(rec.reason, 'empty-cue', 'fixture takes the recency branch');
    assert.equal(rec.hits.length, 1);
    assert.equal(rec.hits[0].anchored, true, 'recency is its own stated anchor, not a relevance claim');
    assert.deepEqual(rec.hits[0].anchors, ['recency']);

    const goal = await m.recall({ query: CUE });
    assert.equal(goal.hits[0].anchored, false, 'the same row viewed against a cue is a vector neighbour');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZZANC10 belt price: the floor and relativeScore are untouched by the anchor flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-anchor-default-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  try {
    assert.equal(m.options.similarityThreshold, 0.32, 'the default floor is unchanged');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const s = anchorStore('anchor-rel');
  try {
    await s.m.remember({ kind: 'semantic', summary: 'ZZB1 the mysql credentials rotate every Tuesday' });
    await s.m.remember({ kind: 'episode', summary: 'ZZB2 kafka consumers lag behind the writer' });
    const rec = await s.m.recall({ query: CUE });
    assert.equal(rec.hits.length, 2, 'both clear the lowered fixture floor');
    const top = Math.max(...rec.hits.map((h) => h.similarity));
    for (const h of rec.hits) {
      assert.equal(h.relativeScore, Number((h.similarity / top).toFixed(3)), `relativeScore formula: ${h.summary}`);
    }
    assert.equal(rec.hits.find((h) => h.similarity === top).relativeScore, 1, 'the best is still 1.0');
  } finally {
    s.m.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
