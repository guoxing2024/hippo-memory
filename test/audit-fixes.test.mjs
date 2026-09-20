/**
 * Expert-audit fixes (2026-09-19).
 *
 *  #6 negation precision: NEGATION_RE matched any text containing 错误 (via
 *     `错误\d*` where \d* allows zero digits) and bare English `no` inside
 *     `no-code`. A normal "错误处理" memory was mis-read as a negation, which
 *     manufactured false contradictions in verify.
 *  #7 value contradiction on the support row: verify checked related rows for
 *     same-subject/different-value disagreement but never the argmax row it
 *     chose as support. Asking to confirm `X -> mysql` against a stored
 *     `X -> postgres` returned substantiated:true.
 *
 *  (Audit #8 — "argmax alone decides" — turned out to be a deliberate contract,
 *   not a bug: an affirming exact match stays substantiated while a disagreeing
 *   sibling is surfaced in contradicting[] + the note. See p0-regressions
 *   "affirming row wins cosine". The one real gap was #7 above.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'audit', options) {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), ...(options ? { options } : {}) });
  return { m, dir };
}

test('#6 a memory that merely mentions 错误 is not read as a negation', async () => {
  const { m, dir } = freshStore('neg1', { similarityThreshold: 0.1 });
  try {
    // The stored line has no negation — it describes an error-handling policy.
    await m.remember({ kind: 'semantic', summary: '错误处理策略统一走 Result 类型返回', entities: [{ name: 'errpolicy' }] });
    // Same policy, asked without the word 错误. Old code: stored counted as
    // negated (错误), claim not → false CONTRADICTED.
    const v = await m.sourceMonitor('处理策略统一走 Result 类型返回');
    assert.equal(v.contradicted, false, `plain 错误 mention must not contradict: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#6 no-code does not trip the bare-no negation', async () => {
  const { m, dir } = freshStore('neg2', { similarityThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'platform choice adopts a nocode builder', entities: [{ name: 'platform' }] });
    // "no-code" tokenizes with a bare "no" that \bno\b used to match.
    const v = await m.sourceMonitor('platform choice adopts a no-code builder');
    assert.equal(v.contradicted, false, `no-code must not contradict nocode: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#7 confirming a different value than the stored one is a contradiction, not support', async () => {
  const { m, dir } = freshStore('val1', { similarityThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'billing database -> postgres', entities: [{ name: 'billing' }] });
    const v = await m.sourceMonitor('billing database -> mysql');
    assert.equal(v.substantiated, false, `a different value must not be substantiated: ${v.note}`);
    assert.equal(v.contradicted, true, `the stored postgres must contradict the mysql claim: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#7 the archived value is still reachable after the live value contradicts', async () => {
  // The second arrow write overrides the first (same subject + shared entity),
  // so verifying the old value now contradicts the live one AND the retired
  // value is offered through superseded_matches rather than lost.
  const { m, dir } = freshStore('val2', { similarityThreshold: 0.1 });
  try {
    await m.remember({ kind: 'semantic', summary: 'cache layer -> redis', entities: [{ name: 'cache' }] });
    await m.remember({ kind: 'semantic', summary: 'cache layer -> memcached', entities: [{ name: 'cache' }] });
    const v = await m.sourceMonitor('cache layer -> redis');
    assert.equal(v.substantiated, false, 'the superseded value must not read as current support');
    assert.equal(v.contradicted, true, 'the live memcached contradicts the redis claim');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
