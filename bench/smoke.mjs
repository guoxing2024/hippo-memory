/**
 * Smoke test for the bench scenario itself (no build needed at runtime).
 * Runs a miniature version to eyeball override behavior before the real run.
 */
import { HippoMemory } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hippo-smoke-'));
const mem = new HippoMemory({ dbPath: join(dir, 'smoke.db') });

const r1 = await mem.remember({
  kind: 'semantic',
  summary: 'which database does the billing service use? -> postgres',
  detail: 'the billing service database is postgres',
  source: 'user'
});
console.log('r1:', r1.outcome, r1.memory.version);

const r2 = await mem.remember({
  kind: 'semantic',
  summary: 'which database does the billing service use? -> mysql',
  detail: 'we migrated the billing service from postgres to mysql',
  source: 'user'
});
console.log('r2:', r2.outcome, r2.memory.version);

const rec = await mem.recall({ query: 'which database does the billing service use?' }, 3);
console.log('recall hits:', rec.hits.map((h) => `${h.summary} (v${h.version}, sim ${h.score.toFixed(3)})`));
console.log('warnings:', rec.warnings);

const monitor = await mem.sourceMonitor('the billing service uses postgres');
console.log('monitor postgres:', monitor.substantiated, monitor.contradicted ? 'CONTRADICTED' : '', monitor.note.slice(0, 90));

mem.close();
rmSync(dir, { recursive: true, force: true });
