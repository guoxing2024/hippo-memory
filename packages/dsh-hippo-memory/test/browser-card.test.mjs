/**
 * Browser-half contract: the hippo-memory card on the DSH Plugins page.
 *
 * The card is a `window.__ModuleLoader__` bundle, so it is loaded here with a
 * fake module loader and a fake `require`, then exercised against the 0.1.7
 * client configuration surface (`ctx.configForms`) and the plugin-manager slot
 * it registers into. These are the assertions that would have caught the
 * settingsScope/settings.plugin.item removal the first time round.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ENTRY_ID = 'hippo-memory'; // this bundle's cordis.patch.yml row id
const BUNDLE = 'dsh-hippo-memory'; // our package name, as the profile lists it

let card; // { apply, inject } from the bundle factory
let node; // window.__ModuleLoader__.load() payload
let required = []; // every module name the factory asked the shell for

/** Run the bundle through a fake module loader and return its exports. */
async function loadBundle() {
  required = [];
  const loaded = [];
  globalThis.window = { __ModuleLoader__: { load: (m) => loaded.push(m) } };
  globalThis.document = undefined;
  await import(`../lib/client.js?t=${Date.now()}`);
  const mod = loaded.find((m) => m.id === BUNDLE);
  assert.ok(mod, 'the bundle registers itself under its package name');
  const require = (name) => {
    required.push(name);
    if (name === 'react') return { useState: (v) => [v, () => {}] };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (t, p) => ({ type: t, props: p }) };
    // Stand-in for the shell's static module table. Whether a name here is
    // legal at all is its own assertion, so one bad require cannot mask the
    // rest of the contract.
    return {};
  };
  return { node: mod, card: mod.factory(require) };
}

/** A client ctx exposing the 0.1.7 configuration form surface. */
function fakeClient({ status = 'ready', value = {}, revision = 7 } = {}) {
  const bound = [];
  const served = [];
  const writes = [];
  let snapshot = { status, value, base: {}, user: {}, revision, writable: true, mode: 'host' };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { scope.listener = listener; return () => {}; },
    mutate: async (ops, expectedRevision) => { writes.push({ ops, expectedRevision }); return true; },
    set: (field, v) => { snapshot = { ...snapshot, value: { ...snapshot.value, [field]: v } }; return Promise.resolve(true); }
  };
  const ctx = {
    registrations: [],
    disposers: [],
    locale: { register: () => () => {}, bind: () => () => 'x' },
    configForms: {
      get: (entryId) => { bound.push(entryId); return scope; },
      describe: () => ({ getSnapshot: () => ({ writable: true, namespaces: [] }), ensure: () => Promise.resolve(), subscribe: () => () => {} }),
      whileServed: (namespaces, register) => {
        served.push(namespaces);
        ctx.disposers.push(register(new Set(namespaces)));
        return () => {};
      }
    },
    slots: {
      // accepts either a generator of contributions or a function returning one
      inject: (name, fn) => {
        const result = fn();
        if (result && typeof result.next === 'function') for (const entry of result) void entry;
        return () => {};
      },
      register: (contribution, Component) => {
        ctx.registrations.push({ contribution, Component });
        return () => {};
      }
    },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; }
  };
  return { ctx, bound, served, writes, scope, setSnapshot: (next) => { snapshot = { ...snapshot, ...next }; } };
}

before(async () => {
  ({ card, node } = await loadBundle());
});

/* ------------------------- the declared surface ------------------------- */

test('the card requires only modules the bundle manifest declares', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = new Set([...manifest.dsh.client.inject, 'react', 'react/jsx-runtime']);
  const undeclared = required.filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [], 'a require the shell table cannot answer kills the whole bundle');
});

test('the card declares configForms, not the removed settingsScope', () => {
  assert.ok(card.inject.includes('configForms'), `inject: ${card.inject}`);
  assert.ok(!card.inject.includes('settingsScope'), 'settingsScope no longer exists on the client');
});

test('the card binds its Host entry id through configForms', () => {
  const h = fakeClient();
  card.apply(h.ctx);
  assert.deepEqual(h.bound, [ENTRY_ID]);
});

test('the card registers into plugins.row.config keyed by bundle and row', () => {
  const h = fakeClient();
  card.apply(h.ctx);
  assert.deepEqual(h.served, [[ENTRY_ID]], 'mounted only while the Host serves the entry');
  const { contribution } = h.ctx.registrations.at(-1);
  assert.equal(contribution.name, 'plugins.row.config');
  assert.equal(contribution.key, `${BUNDLE}#${ENTRY_ID}`);
});

/* ------------------------- the snapshot it renders ------------------------- */

test('the card is bound to the row id the profile patch declares', () => {
  // A mismatch is silent: the Host would serve the entry under its own row id
  // and the card would simply never appear, so pin the coupling here.
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const rowId = patch.match(/^\s*-\s*id:\s*(\S+)\s*$/m)?.[1];
  assert.equal(rowId, ENTRY_ID, 'the settings namespace is the profile row id, not the plugin name');
  assert.equal(manifest.name, BUNDLE);
  const h = fakeClient();
  card.apply(h.ctx);
  assert.equal(h.ctx.registrations.at(-1).contribution.key, `${manifest.name}#${rowId}`);
});

test('only the page view renders the form', () => {
  const h = fakeClient();
  card.apply(h.ctx);
  const { Component } = h.ctx.registrations.at(-1);
  const props = { ...cardProps(h.ctx), t: (key) => key };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return [];
    const children = Array.isArray(node.props?.children) ? node.props.children.flat(4) : [node.props?.children];
    return [node.type, ...children.flatMap(walk)];
  };
  const page = walk(Component({ ...props, view: 'page' }));
  assert.ok(page.includes('input'), 'the page view renders the form controls');
  const summary = walk(Component({ ...props, view: 'summary' }));
  assert.ok(!summary.includes('input') && !summary.includes('button'), 'the row summary renders no form');
});

test('availability follows the snapshot status', () => {
  const ready = fakeClient({ status: 'ready', value: { enabled: true, contextLimit: 6 } });
  card.apply(ready.ctx);
  const store = storeOf(ready.ctx);
  assert.equal(store.getSnapshot().available, true);
  assert.equal(store.getSnapshot().contextLimit.text, '6');

  const gone = fakeClient({ status: 'unavailable' });
  card.apply(gone.ctx);
  assert.equal(storeOf(gone.ctx).getSnapshot().available, false, 'renders nothing over an unserved entry');
});

test('the card re-renders when the Host moves the section under it', () => {
  const h = fakeClient({ revision: 3, value: { contextLimit: 6 } });
  card.apply(h.ctx);
  const store = storeOf(h.ctx);
  let notified = 0;
  store.subscribe(() => { notified++; });
  assert.equal(store.getSnapshot().contextLimit.text, '6');
  h.setSnapshot({ revision: 4, value: { contextLimit: 9 } });
  h.scope.listener(); // the Host form notifies its own listeners
  assert.equal(store.getSnapshot().contextLimit.text, '9', 'the served value is re-read');
  assert.equal(notified, 1, 'and the card is told, or the page shows a stale draft');
});

/* ------------------------------ the save ------------------------------ */

test('a save writes path ops fenced on the revision it staged from', async () => {
  const h = fakeClient({ value: { enabled: true, contextLimit: 6, embedding: 'auto' }, revision: 11 });
  card.apply(h.ctx);
  const actions = actionsOf(h.ctx);
  actions.edit('contextLimit', '9');
  actions.toggle?.('enabled', true);
  actions.resetField('embedding');
  await actions.save();
  const { ops, expectedRevision } = h.writes.at(-1);
  assert.equal(expectedRevision, 11, 'fenced on the revision the drafts started from');
  assert.deepEqual(ops.find((op) => op.path[0] === 'contextLimit'), { op: 'set', path: ['contextLimit'], value: 9 });
  assert.deepEqual(ops.find((op) => op.path[0] === 'embedding'), { op: 'unset', path: ['embedding'] });
});

test('a save fences on the revision the drafts were staged against', async () => {
  // The form is built when the bundle activates, before the Host has answered
  // the first describe — so the fence has to come from the served snapshot at
  // the moment an edit is staged, not from the undefined one at construction.
  const h = fakeClient({ status: 'loading', revision: undefined });
  card.apply(h.ctx);
  const actions = actionsOf(h.ctx);
  h.setSnapshot({ status: 'ready', revision: 21 });
  actions.edit('contextLimit', '9');
  await actions.save();
  assert.equal(h.writes.at(-1).expectedRevision, 21);
});

/* ------------------------------ helpers ------------------------------ */
function storeOf(ctx) {
  return injected(ctx).hooks.hippoMemory;
}

function actionsOf(ctx) {
  const { edit, resetField, save, discard, toggle } = injected(ctx);
  return { edit, resetField, discard, toggle, save: () => Promise.resolve(save()) };
}

/** The payload the slot contribution injects into the card component. */
function injected(ctx) {
  const { contribution } = ctx.registrations.at(-1);
  return contribution.inject();
}

/**
 * The props the slot machinery hands the component: the inject payload, plus
 * each bare store bound to its `use<Name>` hook prop (the same projection
 * `@deepseek-ai/dsh-client-ui-slots` applies before rendering a contribution).
 */
function cardProps(ctx) {
  const { hooks, ...rest } = injected(ctx);
  const bound = Object.entries(hooks).map(([name, store]) => [
    `use${name[0].toUpperCase()}${name.slice(1)}`,
    (select) => select(store.getSnapshot())
  ]);
  return { ...rest, ...Object.fromEntries(bound) };
}
