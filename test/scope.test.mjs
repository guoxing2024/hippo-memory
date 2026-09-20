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
 *   - Compatible-or-absent scopes leave the existing write path untouched.
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

test('scope: a re-tell that supplies the missing premise records it', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZSCOPE11 the retry budget is five attempts' });
    const again = await m.remember({
      kind: 'semantic',
      summary: 'ZZSCOPE11 the retry budget is five attempts',
      scope: 'env=the staging cluster'
    });
    assert.equal(again.outcome, 'none', 'still one trace');
    assert.equal(m.stats().active, 1);
    assert.equal(again.memory.scope, 'env=the staging cluster');

    const bare = await m.remember({ kind: 'semantic', summary: 'ZZSCOPE11 the retry budget is five attempts' });
    assert.equal(bare.memory.scope, 'env=the staging cluster', 'a stated premise survives a premise-free re-tell');
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
      assert.ok(v.out_of_scope || v.support.scope === 'cluster=the eu region', 'legacy row must be reportable as conditional');
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
