/**
 * overrideAudit: the read-only screen for BUG-1 damage.
 * duplicates() cannot see it — an override archives the old row, so no live
 * pair survives to compare. This walks version history instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

test('overrideAudit flags an override that changed the subject', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-audit-'));
  const m = new HippoMemory({ dbPath: join(dir, 't.db') });
  try {
    // A legitimate same-scope correction: wording overlaps heavily -> not flagged.
    await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster B', entities: [{ name: 'deploy' }] });
    await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster C', entities: [{ name: 'deploy' }] });
    const clean = m.overrideAudit();
    assert.equal(clean.scannedOverridden, 1, 'the corrected row is inspected');
    assert.equal(clean.suspicious.length, 0, 'a real correction is not suspicious');

    // Reproduce the damaging shape directly: the same structured subject and a
    // shared entity (so scope passes and the override is authorised), but the
    // bound VALUE is an unrelated topic instead of a refinement.
    await m.remember({
      kind: 'semantic',
      summary: 'deploy target -> quarterly revenue vellum parchment',
      entities: [{ name: 'deploy' }]
    });
    const flagged = m.overrideAudit();
    assert.ok(flagged.suspicious.length >= 1, `unrelated override must be flagged: ${JSON.stringify(flagged.suspicious)}`);
    const hit = flagged.suspicious.find((x) => x.liveSummary.includes('revenue'));
    assert.ok(hit, 'the unrelated row is the one reported');
    assert.ok(hit.overlap < 0.34, `low overlap recorded: ${hit.overlap}`);
    assert.ok(hit.archived.summary.length > 0, 'the archived text is recoverable from the report');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overrideAudit is read-only and reports nothing on a clean store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-audit2-'));
  const m = new HippoMemory({ dbPath: join(dir, 't.db') });
  try {
    await m.remember({ kind: 'semantic', summary: 'alpha -> one' });
    await m.remember({ kind: 'semantic', summary: 'beta -> two' });
    const before = m.stats().active;
    const res = m.overrideAudit();
    assert.equal(res.suspicious.length, 0);
    assert.equal(res.scannedOverridden, 0, 'no row has version > 1');
    assert.equal(m.stats().active, before, 'nothing was modified');
    assert.match(res.note, /read-only/i);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
