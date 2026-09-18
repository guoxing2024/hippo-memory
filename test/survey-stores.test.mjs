/**
 * Who else lives in this cache directory?
 *
 * The bug this exists for: a read comes back empty, and the real reason is a
 * different SQLite file, not a forgotten fact. Nothing in the old status view
 * could show that, because a store only ever looked at itself. `surveyStores`
 * counts the siblings by opening them the same way `prune` already does, and
 * `SCOPE_RULE` states the contract both hosts display — so the explanation is
 * written once, in the engine, not twice in two adapters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory, surveyStores, SCOPE_RULE } from '../dist/index.js';

function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
}

test('survey: an empty or missing directory reports no stores and never throws', () => {
  const dir = freshDir('survey-empty');
  try {
    const s = surveyStores(dir);
    assert.equal(s.dir, dir);
    assert.deepEqual(s.stores, []);
    assert.deepEqual(s.unreadable, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const missing = surveyStores(join(freshDir('survey-gone'), 'nope'));
  assert.deepEqual(missing.stores, [], 'a cache root that does not exist yet is not an error');
});

test('survey: every sibling .db is counted and only the caller\'s own file is flagged current', async () => {
  const dir = freshDir('survey-two');
  try {
    const a = new HippoMemory({ dbPath: join(dir, 'project-a.db') });
    await a.remember({ kind: 'semantic', summary: 'alpha fact one -> 1', source: 'user' });
    await a.remember({ kind: 'semantic', summary: 'alpha fact two -> 2', source: 'user' });
    a.close();
    const b = new HippoMemory({ dbPath: join(dir, 'project-b.db') });
    await b.remember({ kind: 'semantic', summary: 'beta fact one -> 1', source: 'user' });
    b.close();
    // A third file that no one opened yet, named to sort before the others:
    // an empty store is a real state and must read as empty, not as missing.
    new HippoMemory({ dbPath: join(dir, 'aaa-empty.db') }).close();

    const s = surveyStores(dir, { current: join(dir, 'project-a.db') });
    assert.deepEqual(
      s.stores.map((x) => x.file),
      ['project-a.db', 'project-b.db', 'aaa-empty.db'],
      'sorted by rows, then by name — not by readdir order',
    );
    assert.equal(s.stores[0].rows, 2);
    assert.equal(s.stores[0].current, true, 'this is the store answering');
    assert.equal(s.stores[1].rows, 1);
    assert.equal(s.stores[1].current, false);
    assert.equal(s.stores[2].rows, 0, 'an untouched store reads as empty, not as missing');
    assert.ok(s.stores.every((x) => typeof x.lastWrite === 'string' || x.lastWrite === null));
    assert.ok(!s.stores.some((x) => x.path), 'paths stay out of the report; file names are enough');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('survey: demoted rows are counted separately from live recall', async () => {
  const dir = freshDir('survey-demoted');
  try {
    const m = new HippoMemory({ dbPath: join(dir, 'folded.db') });
    const ep = await m.remember({
      kind: 'episode', summary: 'uart fifo depth -> 64 words', entities: [{ name: 'uart' }], source: 'tool', importance: 0.9
    });
    await m.consolidate({ minAccess: 0, minImportance: 0, minAgeMs: 0 });
    await m.mergeDuplicates({ ids: m.duplicates().groups[0].memories.map((x) => x.id), dryRun: false });
    const s = surveyStores(dir);
    assert.equal(s.stores[0].demoted, 1, 'the folded restatement is still in the file, hidden');
    assert.equal(s.stores[0].rows, m.stats().active);
    m.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('survey: a file that is not a store is listed, never fatal', () => {
  const dir = freshDir('survey-junk');
  try {
    writeFileSync(join(dir, 'notes.db'), 'not a database at all', 'utf8');
    const s = surveyStores(dir);
    assert.deepEqual(s.stores, []);
    assert.deepEqual(s.unreadable, ['notes.db'], 'named so status can say why the count is short');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostics carries the survey and the rule, so every host status shows both', async () => {
  const dir = freshDir('survey-self');
  try {
    const other = new HippoMemory({ dbPath: join(dir, 'other-project.db') });
    await other.remember({ kind: 'semantic', summary: 'elsewhere fact -> 7', source: 'user' });
    other.close();
    const m = new HippoMemory({ dbPath: join(dir, 'mine.db') });
    await m.remember({ kind: 'semantic', summary: 'my fact -> 3', source: 'user' });
    const sib = m.diagnostics().sibling_stores;
    assert.equal(sib.dir, dir, 'the survey covers this store own directory');
    assert.equal(sib.stores.find((x) => x.current)?.file, 'mine.db', 'and knows which one is answering');
    assert.equal(sib.stores.find((x) => x.file === 'other-project.db')?.rows, 1, 'and sees what the neighbour holds');
    assert.equal(m.diagnostics().scope_rule, SCOPE_RULE, 'the rule text is the engine s, not a copy');
    m.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suspicious: an empty store beside a full sibling is called out by name', async () => {
  const dir = freshDir('survey-split');
  const opened = [];
  const open = (file) => {
    const inst = new HippoMemory({ dbPath: join(dir, file) });
    opened.push(inst);
    return inst;
  };
  try {
    const other = open('other-project.db');
    await other.remember({ kind: 'semantic', summary: 'elsewhere fact -> 7', source: 'user' });
    other.close();

    assert.equal(open('mine.db').diagnostics().suspicious.emptyWhileSiblingsFull, true, 'the split is the story');

    assert.equal(
      open('other-project.db').diagnostics().suspicious.emptyWhileSiblingsFull,
      false,
      'a store with its own memories is not a victim of the split',
    );
  } finally {
    for (const inst of opened) {
      try {
        inst.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suspicious: an empty store with no full neighbour stays quiet', () => {
  const dir = freshDir('survey-alone');
  const m = new HippoMemory({ dbPath: join(dir, 'only.db') });
  try {
    assert.equal(m.diagnostics().suspicious.emptyWhileSiblingsFull, false, 'nothing next door, nothing to blame');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCOPE_RULE: the contract is stated once, in the engine', () => {
  assert.equal(typeof SCOPE_RULE, 'string');
  assert.ok(SCOPE_RULE.length > 40);
  assert.match(SCOPE_RULE, /never cross|one store|per /i, 'it must say memories do not travel between files');
  assert.match(SCOPE_RULE, /empty/i, 'and name the failure mode it explains');
});
