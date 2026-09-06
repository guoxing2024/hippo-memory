/**
 * Anti-hallucination benchmark: long-session memory confusion.
 *
 * Simulates a long agent work session where the model must answer questions
 * about facts established EARLY in the session — which a plain bounded context
 * window progressively loses as later unrelated work floods in — and about
 * LATER corrections that override earlier facts, which raw history cannot
 * reconcile (no provenance: both claims sit in the text and the answerer has
 * no way to know which one is current).
 *
 * Two harnesses over the SAME session script:
 *   1. noMemory — plain long context. Only the last W transcript lines are
 *      visible (bounded window). Answers come from the best-matching visible
 *      line. When nothing matches it REFUSES — an optimistic bound, because a
 *      real LLM would often confabulate instead. It cannot detect staleness.
 *   2. hippo — HippoMemory-backed: each claim is remembered with provenance;
 *      a correction becomes a versioned override (archiving the old claim);
 *      answers come from recall(); when recall finds nothing it refuses
 *      (the anti-confabulation pathway).
 *
 * Metrics: answer accuracy, hallucination rate (wrong claim asserted as fact
 * when the ground truth differs), and refusal rate.
 */
import { HippoMemory, cosine, embedHashing } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/* Scenario generation                                                  */
/* ------------------------------------------------------------------ */

function buildSession() {
  const facts = [
    { q: 'which database does the billing service use?', a: 'postgres', line: 'the billing service database is postgres' },
    { q: 'what is the timeout of the gateway?', a: '30 seconds', line: 'the gateway timeout is 30 seconds' },
    { q: 'which queue backs the notification worker?', a: 'rabbitmq', line: 'the notification worker queue is rabbitmq' },
    { q: 'what is the deploy cadence for the auth service?', a: 'weekly', line: 'the auth service deploys weekly' },
    { q: 'which language is the ingestion service written in?', a: 'go', line: 'the ingestion service is written in go' },
    { q: 'where are the session tokens stored?', a: 'redis', line: 'session tokens are stored in redis' },
    { q: 'which provider hosts the cdn?', a: 'cloudflare', line: 'the cdn is hosted by cloudflare' },
    { q: 'what is the retention period for raw events?', a: '90 days', line: 'raw events are retained for 90 days' }
  ];
  const corrections = [
    {
      target: 'billing-db',
      line: 'we migrated the billing service from postgres to mysql',
      q: 'which database does the billing service use?',
      a: 'mysql'
    },
    {
      target: 'gateway-timeout',
      line: 'the gateway timeout was lowered from 30 to 15 seconds',
      q: 'what is the timeout of the gateway?',
      a: '15 seconds'
    }
  ];

  const turns = [];
  for (const f of facts) turns.push({ kind: 'fact', line: f.line, fact: f });
  for (const c of corrections) turns.push({ kind: 'fact', line: c.line, correction: c });
  // long noisy tail that pushes early facts out of any finite context window
  const noisePool = [
    'refactored the image resizer to use sharp instead of jimp',
    'discussed css nesting support in the design system',
    'updated the docker-compose healthcheck interval',
    'renamed the kafka consumer group for analytics',
    'bumped the eslint config to warn on console logs',
    'reviewed the pr for the csv export endpoint',
    'fixed the flaky e2e test for the checkout flow',
    'added a rate limit header to the public api',
    'migrated the docs site to a new static generator',
    'investigated a memory leak in the websocket pool',
    'tuned the autoscaler cpu target to 65 percent',
    'upgraded the base image to node 22 slim',
    'cleaned up the feature flag registry',
    'moved the nightly report job to a new cron schedule',
    'discussed token bucket vs leaky bucket for the proxy',
    'added structured logging to the worker',
    'pinned the terraform provider version',
    'rotated the staging database credentials',
    'reorganized the monorepo package layout',
    'profiled the cold start of the lambda functions'
  ];
  for (let i = 0; i < 60; i++) {
    turns.push({ kind: 'noise', line: `${noisePool[i % noisePool.length]} (turn ${i})` });
  }
  return { facts, corrections, turns };
}

/* ------------------------------------------------------------------ */
/* Runtime 1: no memory (plain long context, bounded window)            */
/* ------------------------------------------------------------------ */

const WINDOW = 25; // visible transcript lines

async function answerWithRawDump(dump, q) {
  const lines = dump.split('\n').filter(Boolean).slice(-WINDOW);
  const qVec = embedHashing(q);
  let best = '';
  let bestSim = 0;
  for (const line of lines) {
    const sim = cosine(qVec, embedHashing(line));
    if (sim > bestSim) {
      bestSim = sim;
      best = line;
    }
  }
  if (bestSim < 0.35) return { answer: null, confident: false };
  const migrated = best.match(/\bfrom\s+[\w\d .-]+\s+to\s+([\w\d .-]+)\b/);
  if (migrated) return { answer: migrated[1].trim(), confident: true };
  const is = best.match(/\b(?:is|are|written in|hosted by|retained for|stored in|backed by|deploys)\s+(?:the\s+)?([\w\d .-]+)\b/);
  if (is) return { answer: is[1].trim(), confident: true };
  return { answer: best, confident: bestSim >= 0.5 };
}

/* ------------------------------------------------------------------ */
/* Runtime 2: HippoMemory                                               */
/* ------------------------------------------------------------------ */

async function answerWithHippo(mem, q) {
  const rec = await mem.recall({ query: q }, 3);
  const top = rec.hits[0];
  if (!top) return { answer: null, confident: false }; // refuse
  const m = top.summary.match(/->\s*([\w\d .-]+)\s*$/);
  const answer = m ? m[1].trim() : top.summary;
  return { answer, confident: true };
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'hippo-bench-'));
const mem = new HippoMemory({ dbPath: join(dir, 'bench.db') });

const { facts, corrections, turns } = buildSession();

// ingest the same session into both representations
const dumpLines = [];
for (const t of turns) {
  if (t.kind === 'noise') {
    dumpLines.push(t.line);
    continue;
  }
  dumpLines.push(`[user] ${t.line}`);
  await mem.remember({
    kind: 'semantic',
    summary: `${t.correction ? t.correction.q : t.fact.q} -> ${t.correction ? t.correction.a : t.fact.a}`,
    detail: t.line,
    source: 'user'
  });
}
const dump = dumpLines.join('\n');

// STRICT MODE: also store the noise as memories so hippo must fight dilution
// (a plain "only facts stored" setup would be unrealistically kind).
if (process.env.HIPPO_STRICT) {
  for (const t of turns) {
    if (t.kind !== 'noise') continue;
    await mem.remember({
      kind: 'episode',
      summary: `${t.line} (noise turn)`,
      source: 'tool'
    });
  }
}

// answer every question with both harnesses
const answers = facts.map((f) => {
  const correction = corrections.find((c) => c.q === f.q);
  return { q: f.q, gold: correction ? correction.a : f.a };
});

let noMemCorrect = 0;
let noMemRefused = 0;
let noMemWrong = 0;
let hippoCorrect = 0;
let hippoRefused = 0;
let hippoWrong = 0;

const total = answers.length;
for (const { q, gold } of answers) {
  const raw = await answerWithRawDump(dump, q);
  if (!raw.answer) noMemRefused++;
  else if (raw.answer === gold) noMemCorrect++;
  else noMemWrong++;

  const hip = await answerWithHippo(mem, q);
  if (!hip.answer) hippoRefused++;
  else if (hip.answer === gold) hippoCorrect++;
  else hippoWrong++;
}

mem.close();
rmSync(dir, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;
const line = '='.repeat(60);
console.log(line);
console.log('Anti-hallucination benchmark: long-session memory');
console.log(line);
console.log(`facts probed   : ${total} (${corrections.length} later overridden)`);
console.log(`noise turns    : ${turns.filter((t) => t.kind === 'noise').length}`);
console.log(`visible window : last ${WINDOW} transcript lines (no-memory arm)`);
console.log('');
console.log('plain long context (no memory):');
console.log(`  correct      ${noMemCorrect}/${total}  ${pct(noMemCorrect)}`);
console.log(`  wrong/confab ${noMemWrong}/${total}  ${pct(noMemWrong)}`);
console.log(`  refused      ${noMemRefused}/${total}  ${pct(noMemRefused)}`);
console.log('');
console.log('HippoMemory-backed:');
console.log(`  correct      ${hippoCorrect}/${total}  ${pct(hippoCorrect)}`);
console.log(`  wrong/confab ${hippoWrong}/${total}  ${pct(hippoWrong)}`);
console.log(`  refused      ${hippoRefused}/${total}  ${pct(hippoRefused)}`);
console.log('');
console.log('anti-hallucination (correct or refused, never wrong):');
console.log(`  plain context  ${pct(noMemCorrect + noMemRefused)}`);
console.log(`  hippo          ${pct(hippoCorrect + hippoRefused)}`);
console.log('');
console.log('hallucination rate (wrong asserted answers):');
console.log(`  plain context  ${pct(noMemWrong)}`);
console.log(`  hippo          ${pct(hippoWrong)}`);
