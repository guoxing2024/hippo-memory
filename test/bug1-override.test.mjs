/**
 * BUG-1 regression (field report, 5th round): memory_remember silently
 * overwrote unrelated memories.
 *
 * Root causes pinned here:
 *   (a) override branch 0 matched on a structured-claim SUBJECT key alone.
 *       `claimParts` extracts a subject from ordinary prose too
 *       ("the meeting room booking is handled..." → "the meeting room booking"),
 *       so unrelated sentences sharing a noun phrase collided. Cosine was never
 *       consulted, which is why the documented 0.86 bar did not apply.
 *   (b) the scope check in branch 3 read `entities.length === 0 || ... === '[]'
 *       || overlap` — "no entities declared" counted as shared scope.
 *   (c) the only notice was the returned `superseded` field, easy to miss.
 *
 * The fix requires shared entities (or an explicit `supersedes`) to overwrite,
 * and always reports an override in `warning`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-bug1-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  return { m, dir };
}

test('BUG-1: same subject key but no shared entity does NOT overwrite', async () => {
  const { m, dir } = freshStore();
  try {
    // The claimParts trap: both sentences yield subject "the meeting room
    // booking", but they are unrelated statements with disjoint entities.
    await m.remember({
      kind: 'semantic',
      summary: 'the meeting room booking is handled two days ahead',
      entities: [{ name: 'booking-a' }]
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'the meeting room booking is managed by the facilities team',
      entities: [{ name: 'booking-b' }]
    });
    assert.equal(second.outcome, 'new', 'unrelated write must create a new trace');
    assert.equal(second.superseded, undefined, 'nothing may be retired');
    assert.equal(m.stats().active, 2, 'both memories must survive');
    // The overlap is still reported, just not destructive.
    assert.ok(
      second.scope_only_matches?.length,
      `the same-key/no-scope row must be surfaced: ${JSON.stringify(second.scope_only_matches)}`
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-1: disjoint entities never overwrite even at high similarity', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({
      kind: 'semantic',
      summary: 'pigcore 硬排除集更正 -> 诚实值 135,326',
      entities: [{ name: 'pigcore' }],
      source: 'user'
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'pigcore 本轮我犯的 8 个错误，逐条记录并修正',
      entities: [{ name: 'mistake-log' }],
      source: 'user'
    });
    assert.equal(second.outcome, 'new', 'different subject must not overwrite');
    assert.equal(m.stats().active, 2);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-1: a genuine same-scope correction still overrides, and says so', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster B', entities: [{ name: 'deploy' }] });
    const second = await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster C', entities: [{ name: 'deploy' }] });
    assert.equal(second.outcome, 'override', 'same subject + shared entity is a real correction');
    assert.ok(second.superseded, 'the retired trace is identified');
    assert.equal(m.stats().active, 1, 'one engram, versioned');
    // (c) an override is never silent any more.
    assert.ok(second.warning, 'override must explain itself');
    assert.match(second.warning, /override:/);
    assert.match(second.warning, /supersedes/);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-1: entity-less rows no longer overwrite each other on cosine alone', async () => {
  const { m, dir } = freshStore();
  try {
    // Previously `entities.length === 0` counted as "shares scope", so two
    // entity-less rows could replace one another purely on similarity.
    await m.remember({ kind: 'semantic', summary: 'the cache layer holds session tokens' });
    const second = await m.remember({ kind: 'semantic', summary: 'the cache layer holds session token' });
    assert.notEqual(second.outcome, 'override', 'no entities declared => no scope => no overwrite');
    assert.equal(m.stats().active, 2);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-1: explicit supersedes still forces a retirement', async () => {
  const { m, dir } = freshStore();
  try {
    const first = await m.remember({ kind: 'semantic', summary: 'legacy note about the old cache', entities: [{ name: 'cache' }] });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'cache note rewritten',
      entities: [{ name: 'cache' }],
      supersedes: [first.memory.id]
    });
    assert.equal(second.outcome, 'supersede', 'an explicit intent must still work');
    assert.equal(m.get(first.memory.id), undefined, 'named row retired');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-1 recurrence: shared entity + high cosine but different subjects does NOT overwrite', async () => {
  const { m, dir } = freshStore();
  try {
    // The incident shape: near-identical prose ("users" vs "clients" is the
    // only difference), shared entity, cosine above the contradiction bar —
    // but the two rows are about different things and neither negates the
    // other. Previously path #3 overwrote on cosine + entity alone (measured
    // 0.880 on unrelated rows under bge). Now disagreement evidence is
    // required too, so this stays a new trace with visible neighbours.
    await m.remember({
      kind: 'semantic',
      summary: 'the cache layer holds session tokens for authenticated users',
      entities: [{ name: 'cache' }]
    });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'the cache layer holds session tokens for authenticated clients',
      entities: [{ name: 'cache' }]
    });
    assert.equal(second.outcome, 'new', 'no disagreement evidence => no overwrite');
    assert.equal(second.superseded, undefined, 'nothing retired');
    assert.equal(m.stats().active, 2, 'both rows survive');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-1 recurrence: opposite polarity on shared entity still overrides', async () => {
  const { m, dir } = freshStore();
  try {
    // The disagreement channel that path #3 keeps: same scope, one side
    // negates. "holds" is not a copula in claimParts, so no structured
    // subject exists on either side — polarity is the only evidence, and it
    // suffices here. (Measured cosine 0.88 under the hashing embedder, so
    // this exercises path #3 rather than the write-time merge.)
    await m.remember({ kind: 'semantic', summary: 'cache holds tokens', entities: [{ name: 'cache' }] });
    const second = await m.remember({
      kind: 'semantic',
      summary: 'cache holds no tokens',
      entities: [{ name: 'cache' }]
    });
    assert.equal(second.outcome, 'override', 'negated correction on shared scope still overrides');
    assert.ok(second.warning && second.warning.includes('path-3'), 'warning names the firing path');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
