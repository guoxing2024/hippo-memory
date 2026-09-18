/**
 * The digest no longer goes silent when nothing clears the floor.
 *
 *  below-threshold cue: show the closest trace, marked as a guess, keep the
 *    status line (fail-visible stays) and never give it VERIFIED/ASSERTED.
 *  zero overlap / empty store: no guess — there is nothing to guess from.
 *  confident hit: unchanged rendering, no marker.
 *  counters: process-local coverage of how often the gate stayed quiet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'digest') {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  return { m, dir };
}

test('digest: a below-threshold cue still shows its closest trace, marked as a guess', async () => {
  const { m, dir } = freshStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
    const probe = await m.recall({ query: 'billing oracle' });
    assert.equal(probe.reason, 'below-threshold', `fixture must miss the floor: ${probe.bestSimilarity}`);

    const ctx = await m.composeContext('billing oracle');
    assert.equal(ctx.items.length, 1, 'the closest trace is offered');
    assert.equal(ctx.items[0].lowConfidence, true, 'flagged on the item, not only in prose');
    assert.ok(ctx.context.includes('[low-confidence'), `marked in the rendered block: ${ctx.context}`);
    assert.match(ctx.context, /^1\. \[semantic/m, 'the guess is the first line, numbered as such');
    assert.match(ctx.context, /postgres/, 'the caller sees what is actually closest');
    assert.ok(ctx.warnings.some((w) => /guess|not a memory/i.test(w)), `warning explains the standing: ${ctx.warnings}`);
    assert.ok(!ctx.context.includes('[ASSERTED]') && !ctx.context.includes('[VERIFIED]'), 'a guess carries no evidence standing');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('digest: a cue with no overlap at all gets no guess', async () => {
  const { m, dir } = freshStore('digest-none');
  try {
    await m.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
    const ctx = await m.composeContext('qwerty frobnicate');
    assert.equal(ctx.items.length, 0, 'similarity 0 is not a hunch worth injecting');
    assert.ok(!ctx.context.includes('[low-confidence'), ctx.context);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('digest: an empty store gets no guess either', async () => {
  const { m, dir } = freshStore('digest-empty');
  try {
    const ctx = await m.composeContext('anything at all', { includeRecent: true });
    assert.equal(ctx.items.length, 0);
    assert.ok(ctx.context.includes('no memory above threshold'), 'failure stays visible');
    assert.ok(!ctx.context.includes('[low-confidence'), ctx.context);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('digest: a confident hit renders without the low-confidence marker', async () => {
  const { m, dir } = freshStore('digest-hit');
  try {
    await m.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
    const ctx = await m.composeContext('billing service database');
    assert.ok(ctx.items.length >= 1, 'goal-relevant hit present');
    assert.ok(ctx.items.every((i) => !i.lowConfidence), 'none of them is a guess');
    assert.ok(!ctx.context.includes('[low-confidence'), ctx.context);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostics: coverage counts digest turns, misses and surfaced guesses', async () => {
  const { m, dir } = freshStore('digest-count');
  try {
    await m.remember({ kind: 'semantic', summary: 'billing service database -> postgres', source: 'user' });
    await m.composeContext('billing service database');   // hit
    await m.composeContext('billing oracle');              // miss, guess shown
    await m.composeContext('qwerty frobnicate');           // miss, nothing to show
    const cov = m.diagnostics().coverage;
    assert.equal(cov.turns, 3, 'every gate call counted');
    assert.equal(cov.misses, 2, 'two of them cleared nothing');
    assert.equal(cov.guesses, 1, 'one miss still had a closest trace');
    assert.equal(cov.scope, 'process', 'counts are per process, not persisted history');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
