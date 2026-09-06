/**
 * HippoMemory minimal quickstart (run: node examples/quickstart.mjs)
 *
 * Five standard steps:
 *   1. write    — remember() every fact/event the agent learns
 *   2. read     — recall() when a question arrives (cue-driven retrieval)
 *   3. verify   — sourceMonitor() BEFORE asserting facts (anti-confabulation)
 *   4. gate     — composeContext() builds the compact memory snippet for the prompt
 *   5. offline  — consolidate() + forget() at session end / on a timer
 *
 * Note: content language is English here only to keep exact-token overlap high
 * with the built-in hash encoder. With a real embedding model (setEmbedder),
 * any language works.
 */
import { HippoMemory } from '../dist/index.js';

// ── 0. init: the db file IS the long-term memory (survives restarts) ──
const mem = new HippoMemory({ dbPath: './demo-memory.db' });

// ── 1. write ──
await mem.remember({
  kind: 'semantic',                              // episode | semantic | procedure
  summary: 'billing service database -> postgres', // structured claim "<subject> -> <value>"
  detail: 'the user said billing has always used postgres',
  entities: [{ name: 'billing' }],
  tags: ['database'],
  source: 'user',                                // provenance
  confidence: 'high'                             // high|medium|low|speculative
});

await mem.remember({
  kind: 'episode',                               // episodic: one event
  summary: 'user migrated billing from postgres to mysql on 2025-06-01',
  episode: { time: '2025-06-01', place: 'migration window' },
  entities: [{ name: 'billing' }, { name: 'mysql' }],
  occurredAt: '2025-06-01T02:00:00Z',
  source: 'user',
  confidence: 'high'
});

// ── 2. read: use the question itself as the retrieval cue ──
const { hits, warnings } = await mem.recall(
  { query: 'which database does the billing service use?', entities: ['billing'] },
  5
);
console.log('── recall ──');
for (const h of hits) {
  console.log(`  [${h.kind} v${h.version}] (sim=${h.score.toFixed(2)}, src=${h.source}) ${h.summary}`);
}
if (warnings.length) console.log('  ⚠', warnings);

// ── 3. source monitoring BEFORE answering from memory ──
console.log('\n── sourceMonitor ──');
const supported = await mem.sourceMonitor('billing service database is postgres');
console.log(`  "billing uses postgres" -> substantiated=${supported.substantiated} contradicted=${supported.contradicted}`);
console.log(`    ${supported.note}`);
const unsupported = await mem.sourceMonitor('billing service runs on kubernetes with helm charts');
console.log(`  "billing runs on k8s"    -> substantiated=${unsupported.substantiated} contradicted=${unsupported.contradicted}`);
console.log(`    ${unsupported.note}`);
console.log(`  note: "billing uses oracle" scores 0.46 (same bag of words) and would be`);
console.log(`        wrongly substantiated — a real embedding model fixes this (see README).`);
// convention: when substantiated=false, the agent must answer
// "not in my memory / I don't know" instead of inventing a fact.

// ── 4. working-memory gate: build the prompt snippet ──
console.log('\n── composeContext (inject this into the prompt) ──');
const { context } = await mem.composeContext('fix the billing connection after the migration', {
  limit: 4,
  includeRecent: true
});
console.log(context);

// ── 5. offline maintenance ──
const made = await mem.consolidate({ minAccess: 2 });
console.log(`\n── consolidate: produced ${made.length} semantic rule(s) ──`);
for (const m of made) console.log(`  ✓ ${m.summary}`);
const dry = mem.forget({ dryRun: true });
console.log(`── forget(dryRun): would forget ${dry.forgotten.length} trace(s) ──`);

console.log(`\nstore stats: ${JSON.stringify(mem.stats())}`);
mem.close();
console.log('\n✅ done. Memory persisted in ./demo-memory.db (re-run reuses it).');
