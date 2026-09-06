/**
 * Unit tests for the vector utilities.
 * Run with: npm test  (after build)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, dot, embedHashing, l2, normalize, tokenize, centroid } from '../dist/vectors.js';

test('tokenize handles unicode and punctuation', () => {
  assert.deepEqual(tokenize('Hello, 世界! foo-bar'), ['hello', '世界', 'foo', 'bar']);
});

test('embedHashing is deterministic and unit-length', () => {
  const a = embedHashing('the cat sat on the mat');
  const b = embedHashing('the cat sat on the mat');
  assert.deepEqual(a, b);
  const n = Math.sqrt(dot(a, a));
  assert.ok(Math.abs(n - 1) < 1e-6, `norm should be ~1, got ${n}`);
});

test('cosine similarity is higher for related text than unrelated text', () => {
  const related = cosine(embedHashing('deploy the server to production'), embedHashing('deploy server production'));
  const unrelated = cosine(embedHashing('deploy the server to production'), embedHashing('buy milk and bread at the market'));
  assert.ok(related > unrelated, `related=${related} should exceed unrelated=${unrelated}`);
  assert.ok(related > 0.3);
});

test('l2 and normalize behave', () => {
  const v = [3, 4];
  assert.equal(l2(v, [0, 0]), 5);
  const n = normalize(v);
  assert.ok(Math.abs(Math.sqrt(dot(n, n)) - 1) < 1e-9);
});

test('centroid averages', () => {
  const c = centroid([
    [1, 1],
    [3, 3]
  ]);
  assert.deepEqual(c, [2, 2]);
});
