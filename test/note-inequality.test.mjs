/**
 * A note that prints `best similarity 0.54 < 0.54` is worse than no number.
 *
 * Three read-path notes state an inequality between a score and a bar, and each
 * renders the score with `toFixed` to FEWER decimals than the bar's own spelling
 * allows for: rounding moves the printed value UP onto the bar the real score
 * failed to clear. The reader — an LLM copying the note into an answer, or a
 * human debugging a store — cannot tell that artifact from an engine that
 * contradicts itself.
 *
 * Measured in the hashing space, so the fixtures are the engine's own numbers:
 *
 *  1  `UNSUBSTANTIATED … (best similarity X < floor)`        src/memory.ts:2900
 *  2/3 `[low-confidence sim X < floor Y: the closest trace…]` src/memory.ts:3593
 *  4  `no hit cleared the similarity floor Y; closest was X`  src/memory.ts:1945
 *  5  `claim-to-summary similarity X is below the claim bar Y` src/memory.ts:3513
 *
 * Each test first pins that the pair really sits in the hazard band — strictly
 * below the bar, close enough that the bar's own decimal spelling rounds onto it
 * — so the assertion cannot pass vacuously if the fixtures drift. Case 3/4 need a
 * floor spelled at three decimals (that is where the second rounding stage bites,
 * and where that note renders), and case 5 needs a synthetic pair because its
 * band is only five thousandths wide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(options) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-notequal-'));
  return { m: new HippoMemory({ dbPath: join(dir, 'test.db'), ...(options ? { options } : {}) }), dir };
}

const write = (m, payload) => m.remember({ kind: 'semantic', tags: ['fact'], ...payload });

/** 0.538413 — rounds to 0.54, which is where the floor is. */
const CI_STORED = 'the build pipeline uses github actions to cache node_modules';
const CI_CLAIM = 'the CI runner uses github actions caches node modules';
/** 0.723822 — rounds to 0.724, which is where the floor is. */
const NODES_STORED = 'nine nodes run the cache and two run the gateway';
const NODES_CLAIM = 'nine nodes run the cache plus one gateway';

test('verify note: the UNSUBSTANTIATED similarity it prints is really below the floor', async () => {
  const { m, dir } = freshStore({ similarityThreshold: 0.54 });
  try {
    await write(m, { summary: CI_STORED });
    const v = await m.sourceMonitor(CI_CLAIM);
    const raw = v.closest.score;
    assert.ok(raw < 0.54 && raw > 0.535, `fixture must still straddle the floor: ${raw}`);
    assert.equal(v.substantiated, false);
    const shown = v.note.match(/best similarity (\d+(?:\.\d+)?) < (\d+(?:\.\d+)?)/);
    assert.ok(shown, `the note names the score and the floor: ${v.note}`);
    assert.ok(
      Number(shown[1]) < Number(shown[2]),
      `the note asserts a false inequality (${shown[1]} < ${shown[2]}) for a score of ${raw.toFixed(6)}: ${v.note}`
    );
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('digest: the low-confidence line prints a similarity below its own floor', async () => {
  const { m, dir } = freshStore({ similarityThreshold: 0.54 });
  try {
    await write(m, { summary: CI_STORED });
    const raw = (await m.sourceMonitor(CI_CLAIM)).closest.score;
    assert.ok(raw < 0.54 && raw > 0.535, `fixture must still straddle the floor: ${raw}`);
    const ctx = await m.composeContext(CI_CLAIM, { includeRecent: false });
    const line = ctx.context.match(/low-confidence sim (\d+(?:\.\d+)?) < floor (\d+(?:\.\d+)?)/);
    assert.ok(line, `the guess line is rendered: ${ctx.context}`);
    assert.ok(
      Number(line[1]) < Number(line[2]),
      `the digest asserts a false inequality (${line[1]} < ${line[2]}): ${ctx.context}`
    );
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('digest: the low-confidence line stays true when the hit field is already rounded onto the floor', async () => {
  // Site 2 renders the digest's guess line off `rec.nearMisses[0].similarity`,
  // and recall rounds THAT field to three decimals at the source
  // (`src/memory.ts:1808`), so a floor spelled at three decimals can have the
  // number arrive already equal to it — truncating once more at render time then
  // changes nothing, and the renderer has to keep stepping down until the
  // sentence it prints is true. Measured: 0.723822 → near-miss field 0.724,
  // floor 0.724.
  const { m, dir } = freshStore({ similarityThreshold: 0.724 });
  try {
    await write(m, { summary: NODES_STORED });
    const rec = await m.recall({ query: NODES_CLAIM }, 3);
    assert.equal(rec.hits.length, 0, 'nothing cleared the floor');
    assert.equal(rec.nearMisses[0].similarity, 0.724, 'the guard: the reported field IS the floor');
    const ctx = await m.composeContext(NODES_CLAIM, { includeRecent: false });
    const line = ctx.context.match(/low-confidence sim (\d+(?:\.\d+)?) < floor (\d+(?:\.\d+)?)/);
    assert.ok(line, `the guess line is rendered: ${ctx.context}`);
    assert.ok(
      Number(line[1]) < Number(line[2]),
      `the digest asserts a false inequality (${line[1]} < ${line[2]}): ${ctx.context}`
    );
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('recall: the below-floor warning prints a closest score under the floor it names', async () => {
  const { m, dir } = freshStore({ similarityThreshold: 0.724 });
  try {
    await write(m, { summary: NODES_STORED });
    const raw = (await m.sourceMonitor(NODES_CLAIM)).closest.score;
    assert.ok(raw < 0.724 && raw > 0.7235, `fixture must still straddle the floor: ${raw}`);
    const rec = await m.recall({ query: NODES_CLAIM }, 3);
    assert.equal(rec.hits.length, 0, `nothing cleared 0.724: ${raw}`);
    const shown = rec.warnings.join(' ').match(/floor (\d+(?:\.\d+)?); closest was (\d+(?:\.\d+)?)/);
    assert.ok(shown, `the warning names both numbers: ${rec.warnings}`);
    assert.ok(
      Number(shown[2]) < Number(shown[1]),
      `the warning says nothing cleared ${shown[1]} while printing ${shown[2]}: ${rec.warnings}`
    );
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify note: the WEAK_MATCH claim-to-summary value is really below the claim bar', async () => {
  // The fourth site is the only one of these that cannot be reached with two
  // sentences: its hazard band is five thousandths wide just under the 0.75 bar
  // ([0.745, 0.75)), and two sentences that close in wording differ by one or
  // two words, which measures 0.91+ and anchors. Found by scanning pairs built
  // from words of five letters or fewer — so no token is distinctive, no
  // identifier is shared, nothing parses — for a cosine inside that band.
  // Measured 0.748686, which `toFixed(2)` rendered as "0.75 is below the claim
  // bar 0.75".
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'task cache disk node shard queue proxy token label index batch route port' });
    const v = await m.sourceMonitor('task cache disk node shard queue proxy token label lock wake drop');
    assert.equal(v.weak_match, true, `nothing anchors this pair: ${v.note}`);
    assert.ok(
      v.support.score < 0.75 && v.support.score >= 0.745,
      `fixture must still straddle the claim bar: ${v.support.score}`
    );
    const shown = v.note.match(/similarity (\d+(?:\.\d+)?) is below the claim bar (\d+(?:\.\d+)?)/);
    assert.ok(shown, `the note names the value it rejected: ${v.note}`);
    assert.ok(
      Number(shown[1]) < Number(shown[2]),
      `the note asserts a false inequality (${shown[1]} below ${shown[2]}): ${v.note}`
    );
  } finally {
    m.close();
    assert.ok(dir);
  }
});
