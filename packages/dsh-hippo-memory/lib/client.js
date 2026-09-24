/* global window */
/**
 * dsh-hippo-memory — browser half.
 *
 * Contributes the configuration page for the `hippo-memory` row of this bundle
 * to the Web GUI Plugins sidebar (插件 → dsh-hippo-memory → hippo-memory). The
 * page edits the volatile Config section the host half of this package exports,
 * addressed by this bundle's profile entry id:
 *
 *   enabled              toggle — mounts/unmounts the memory tools, guidance
 *                        section, and digest context on the host (live)
 *   contextLimit         number — max digest items auto-injected per assembly
 *   sharedStore          toggle — one store for all sessions instead of one per
 *                        session
 *   embedding            select — 'auto' local semantic model, 'off' hashing
 *   similarityThreshold  number — recall similarity floor, empty for the engine
 *                        default
 *
 * The page is a staged form: nothing writes until Save; Save writes one
 * revision-fenced mutation through the entry's configuration form.
 *
 * Module format: browser client modules are `window.__ModuleLoader__.load`
 * bundles (the web shell's CJS-like facade). `@deepseek-ai/*` UI packages,
 * react and react/jsx-runtime resolve through the shell's static module table,
 * which `dsh.client.inject` in package.json has to declare.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hippo-memory',
  factory: (require) => {
    'use strict';

    const { jsx } = require('react/jsx-runtime');

    /** Locale dictionary namespace owned by this card. */
    const NS = 'hippo-memory';
    /** Host profile entry id — since 0.1.7 also the settings namespace. */
    const ENTRY_ID = 'hippo-memory';
    /** The Plugins page slot this row's configuration registers into. */
    const SLOT = 'plugins.row.config';
    const SLOT_KEY = 'dsh-hippo-memory#hippo-memory';

    /* ------------------------------------------------------------------ */
    /* locale dictionaries (zh + en)                                       */
    /* ------------------------------------------------------------------ */

    const en = {
      description: 'Hippocampus-inspired long-term memory: tools, guidance, and per-assembly digest for DSH agents.',
      enabledLabel: 'Enabled',
      enabledHint: 'Mount the memory tools, guidance section, and automatic digest injection.',
      contextLimitLabel: 'Context limit',
      contextLimitHint: 'Maximum digest items auto-injected into the prompt per assembly (1–20).',
      sharedStoreLabel: 'Shared store',
      sharedStoreHint: 'Use one store shared by all sessions instead of one store per session.',
      embeddingLabel: 'Embedding model',
      embeddingHint: 'auto = local model for much stronger recall (CJK / paraphrase); first use downloads ~24MB to ~/.dsh/storages/hippo-memory/models (quantized). off = built-in fast hashing.',
      thresholdLabel: 'Recall threshold',
      thresholdHint: 'Similarity floor 0.05–0.95 for recall/verify. Leave empty for engine default (0.32). Lower = more recall, higher = stricter.',
      invalidThreshold: 'enter a number 0.05–0.95',
      overridden: 'overridden',
      reset: 'reset',
      invalidNumber: 'enter a whole number 1–20',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      failed: 'Save failed — inspect the draft and retry.',
      dirty: 'unsaved changes'
    };
    const zh = {
      description: '海马体式长期记忆：为 DSH agent 提供记忆工具、使用纪律与每轮自动注入的记忆摘要。',
      enabledLabel: '启用',
      enabledHint: '挂载记忆工具、纪律提示段与自动记忆摘要注入。',
      contextLimitLabel: '上下文条数上限',
      contextLimitHint: '每轮装配时自动注入提示词的记忆摘要最大条数（1–20）。',
      sharedStoreLabel: '共享存储',
      sharedStoreHint: '所有会话共享同一个记忆库，而不是每个会话独立一个库。',
      embeddingLabel: '嵌入模型',
      embeddingHint: 'auto = 加载本地模型，召回显著增强（中文/同义表达）；首次使用下载约 24MB（量化版）到 ~/.dsh/storages/hippo-memory/models。off = 内置快速哈希。',
      thresholdLabel: '召回阈值',
      thresholdHint: '召回/验证的相似度下限 0.05–0.95。留空用引擎默认（0.32）。调低=更容易召回，调高=更严格。',
      invalidThreshold: '请输入 0.05–0.95 的数字',
      overridden: '已覆盖',
      reset: '重置',
      invalidNumber: '请输入 1–20 的整数',
      save: '保存',
      discard: '放弃',
      saving: '保存中…',
      failed: '保存失败——请检查草稿后重试。',
      dirty: '有未保存修改'
    };
    const dictionaries = { en, zh };

    /* ------------------------------------------------------------------ */
    /* staged card form (mirrors BashCardController / card-form)           */
    /* ------------------------------------------------------------------ */

    /** Plain staged draft keyed by field name; JSON text for value fields. */
    function createCardForm(scope) {
      // draft: field -> { text, clear } (clear = reset to composition layer)
      let draft = {};
      const listeners = new Set();
      const notify = () => {
        for (const fn of [...listeners]) fn();
      };

      // Draft fingerprint: same revision + same draft => same snapshot identity.
      // useSyncExternalStore re-renders whenever getSnapshot returns a NEW
      // reference, so an uncached snapshot would loop forever (React #185).
      let cachedFingerprint = null;
      let cachedSnapshot = null;

      const fingerprintOf = (snap) => {
        const key = `${snap.revision ?? 0}:${Object.keys(draft).sort().map((f) => `${f}=${draft[f].text ?? (draft[f].clear ? '\u0000' : '')}`).join('|')}`;
        return key;
      };

      const snapshotOf = () => {
        const snap = scope.getSnapshot();
        const fp = fingerprintOf(snap);
        if (cachedFingerprint === fp && cachedSnapshot) return cachedSnapshot;
        cachedFingerprint = fp;
        const value = snap.value ?? {};
        const writable = snap.writable !== false;
        const fields = {
          enabled: {
            text: String(value.enabled ?? true),
            overridden: Object.prototype.hasOwnProperty.call(value, 'enabled')
          },
          contextLimit: {
            text: String(value.contextLimit ?? 6),
            overridden: Object.prototype.hasOwnProperty.call(value, 'contextLimit')
          },
          sharedStore: {
            text: String(value.sharedStore ?? false),
            overridden: Object.prototype.hasOwnProperty.call(value, 'sharedStore')
          },
          embedding: {
            text: String(value.embedding ?? 'auto'),
            overridden: Object.prototype.hasOwnProperty.call(value, 'embedding')
          },
          similarityThreshold: {
            text: value.similarityThreshold === undefined ? '' : String(value.similarityThreshold),
            overridden: Object.prototype.hasOwnProperty.call(value, 'similarityThreshold')
          }
        };
        for (const [field, entry] of Object.entries(draft)) {
          if (entry.clear) {
            fields[field] = { text: '', overridden: false };
          } else if (entry.text !== undefined) {
            fields[field] = { text: entry.text, overridden: entry.text !== '' };
          }
        }
        cachedSnapshot = {
          available: snap.status === 'ready',
          writable,
          saving: false,
          failed: false,
          dirty: Object.keys(draft).length > 0,
          invalid: !validDraft(),
          ...fields
        };
        return cachedSnapshot;
      };

      const validDraft = () => {
        const d = draft.contextLimit;
        if (d && !d.clear && d.text !== undefined) {
          const n = Number(d.text);
          if (!Number.isInteger(n) || n < 1 || n > 20) return false;
        }
        const th = draft.similarityThreshold;
        if (th && !th.clear && th.text !== undefined && th.text.trim() !== '') {
          const n = Number(th.text);
          if (!(n >= 0.05 && n <= 0.95)) return false;
        }
        return true;
      };

      const store = {
        getSnapshot: snapshotOf,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      };

      // The Host form is the only thing that knows when the section moved under
      // us — another tab saved, or the Loader committed a new revision. Without
      // this hop the page keeps showing what it rendered first, since nothing
      // else tells React that getSnapshot() now answers differently.
      const unsubscribe = scope.subscribe?.(() => notify());
      store.dispose = () => unsubscribe?.();

      // The write fence is taken when the first edit of a batch is staged, not
      // when the form is built: the form activates before the Host has answered
      // its first describe, so a fence read here would be undefined.
      let fence;
      const stage = (field, entry) => {
        if (Object.keys(draft).length === 0) fence = scope.getSnapshot().revision;
        draft[field] = entry;
        notify();
      };
      return {
        store,
        edit(field, text) {
          stage(field, { text, clear: false });
        },
        toggle(field, current) {
          stage(field, { text: String(!current), clear: false });
        },
        resetField(field) {
          stage(field, { clear: true });
        },
        async save() {
          const ops = [];
          for (const [field, entry] of Object.entries(draft)) {
            if (entry.clear) ops.push({ op: 'unset', path: [field] });
            else {
              let raw;
              if (field === 'contextLimit') raw = Number(entry.text);
              else if (field === 'embedding') raw = entry.text;
              else if (field === 'similarityThreshold') raw = entry.text.trim() === '' ? undefined : Number(entry.text);
              else raw = entry.text === 'true';
              if (raw === undefined) ops.push({ op: 'unset', path: [field] });
              else ops.push({ op: 'set', path: [field], value: raw });
            }
          }
          if (ops.length === 0) return;
          // A refused write keeps its drafts so the user corrects them instead
          // of retyping; the next accepted save re-seeds from the Host.
          if (await scope.mutate(ops, fence)) {
            draft = {};
            fence = undefined;
          }
          notify();
        },
        discard() {
          draft = {};
          notify();
        }
      };
    }

    /* ------------------------------------------------------------------ */
    /* card face injection                                                 */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, dictionaries),
        'dsh-hippo-memory: dictionaries'
      );

      const form = createCardForm(ctx.configForms.get(ENTRY_ID));

      ctx.effect(
        () => () => {
          form.store.dispose?.();
        },
        'dsh-hippo-memory: card dispose'
      );

      const injected = () => ({
        hooks: {
          hippoMemory: form.store
        },
        edit: (field, text) => form.edit(field, text),
        toggle: (field, current) => form.toggle(field, current),
        resetField: (field) => form.resetField(field),
        save: () => form.save(),
        discard: () => form.discard()
      });

      // Mounted only while the Host actually serves the entry: a profile that
      // never composes the host half of this package shows no trace of the page.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject(
              SLOT,
              () => ctx.slots.register({ name: SLOT, key: SLOT_KEY, locale: NS, inject: injected }, Card)
            )
          ),
        'dsh-hippo-memory: page'
      );
    }

    /* ------------------------------------------------------------------ */
    /* card component                                                      */
    /* ------------------------------------------------------------------ */

    const cardCss = `
.hm-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;margin:0;padding:0 16px}
.hm-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.hm-body{padding:8px 0}
.hm-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.hm-field+.hm-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.hm-row{align-items:center;gap:8px;display:flex}
.hm-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;margin:0}
.hm-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.hm-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:110px;flex:none;box-sizing:border-box}
.hm-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.hm-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.hm-inputInvalid{border-color:var(--dsw-alias-label-error)}
.hm-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.hm-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;padding:4px 0 0}
.hm-switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative;margin:0}
.hm-switchOn{background:var(--dsw-alias-brand-primary)}
.hm-switch:disabled{cursor:default;opacity:.5}
.hm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.hm-thumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}
.hm-switchOn .hm-thumb{transform:translate(16px)}
.hm-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.hm-discard,.hm-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.hm-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.hm-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.hm-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.hm-discard:disabled,.hm-save:disabled{opacity:.4;cursor:default}
.hm-discard:focus-visible,.hm-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="dsh-hippo-memory/card"]')) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-hippo-memory';
      tag.dataset.pluginCss = 'dsh-hippo-memory/card';
      tag.textContent = cardCss;
      document.head.appendChild(tag);
    }

    function Card(props) {
      const { t } = props;
      const state = props.useHippoMemory((snapshot) => snapshot);
      if (!state || state.available === false) return null;
      // The row page asks for two views of one entry: a one-liner under the row
      // title, then the form. Only the form is interactive, so the summary stays
      // plain text — a control inside that paragraph would be invalid markup.
      if (props.view === 'summary') return t('description');
      const disabled = !state.writable;
      const invalidDraft = state.invalid === true;
      return jsx('div', {
        className: 'hm-card',
        children: [
          jsx('div', {
            className: 'hm-body',
            children: [
              fieldRow(t, 'enabled', t('enabledLabel'), t('enabledHint'), state.enabled !== undefined ? state.enabled.text === 'true' : true, !disabled && !state.saving, (checked) => props.toggle('enabled', checked)),
              jsx('div', {
                className: 'hm-field',
                children: [
                  jsx('div', {
                    className: 'hm-row',
                    children: [
                      jsx('label', { className: 'hm-label', htmlFor: 'hm-contextLimit', children: t('contextLimitLabel') }),
                      jsx('input', {
                        id: 'hm-contextLimit',
                        className: 'hm-input' + (invalidDraft ? ' hm-inputInvalid' : ''),
                        type: 'text',
                        inputMode: 'numeric',
                        disabled,
                        value: state.contextLimit ? state.contextLimit.text : '',
                        placeholder: '6',
                        onChange: (e) => props.edit('contextLimit', e.target.value)
                      })
                    ]
                  }),
                  jsx('p', { className: invalidDraft ? 'hm-invalid' : 'hm-hint', children: invalidDraft ? t('invalidNumber') : t('contextLimitHint') })
                ]
              }),
              fieldRow(t, 'sharedStore', t('sharedStoreLabel'), t('sharedStoreHint'), state.sharedStore !== undefined ? state.sharedStore.text === 'true' : false, !disabled && !state.saving, (checked) => props.toggle('sharedStore', checked)),
              jsx('div', {
                className: 'hm-field',
                children: [
                  jsx('div', {
                    className: 'hm-row',
                    children: [
                      jsx('label', { className: 'hm-label', htmlFor: 'hm-embedding', children: t('embeddingLabel') }),
                      jsx('select', {
                        id: 'hm-embedding',
                        className: 'hm-input',
                        style: { width: 'auto' },
                        disabled,
                        value: state.embedding ? state.embedding.text : 'auto',
                        onChange: (e) => props.edit('embedding', e.target.value),
                        children: [
                          jsx('option', { value: 'off', children: 'off (hashing — weakest, no synonyms)' }),
                          jsx('option', { value: 'auto', children: 'auto (local semantic model — recommended)' })
                        ]
                      })
                    ]
                  }),
                  jsx('p', { className: 'hm-hint', children: t('embeddingHint') })
                ]
              }),
              jsx('div', {
                className: 'hm-field',
                children: [
                  jsx('div', {
                    className: 'hm-row',
                    children: [
                      jsx('label', { className: 'hm-label', htmlFor: 'hm-threshold', children: t('thresholdLabel') }),
                      jsx('input', {
                        id: 'hm-threshold',
                        className: 'hm-input' + ((state.thresholdInvalid || invalidDraft) ? ' hm-inputInvalid' : ''),
                        type: 'text',
                        inputMode: 'decimal',
                        disabled,
                        value: state.similarityThreshold ? state.similarityThreshold.text : '',
                        placeholder: '0.32',
                        onChange: (e) => props.edit('similarityThreshold', e.target.value)
                      })
                    ]
                  }),
                  jsx('p', { className: 'hm-hint', children: t('thresholdHint') })
                ]
              }),
              state.failed ? jsx('p', { className: 'hm-error', children: t('failed') }) : null,
              jsx('div', {
                className: 'hm-footer',
                children: [
                  state.dirty ? jsx('span', { className: 'hm-pending', children: t('dirty') }) : null,
                  jsx('button', {
                    type: 'button',
                    className: 'hm-discard',
                    disabled: !state.dirty || state.saving,
                    onClick: () => props.discard(),
                    children: t('discard')
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'hm-save',
                    disabled: invalidDraft || !state.dirty || state.saving,
                    onClick: () => props.save(),
                    children: state.saving ? t('saving') : t('save')
                  })
                ]
              })
            ]
          })
        ]
      });
    }

    function fieldRow(t, id, label, hint, checked, enabled, onToggle) {
      return jsx('div', {
        className: 'hm-field',
        children: [
          jsx('div', {
            className: 'hm-row',
            children: [
              jsx('span', { className: 'hm-label', children: label }),
              jsx('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': checked,
                'aria-label': label,
                className: 'hm-switch' + (checked ? ' hm-switchOn' : ''),
                disabled: !enabled,
                onClick: () => onToggle(checked),
                children: jsx('span', { className: 'hm-thumb' })
              })
            ]
          }),
          jsx('p', { className: 'hm-hint', children: hint })
        ]
      });
    }

    return { apply, inject: ['locale', 'slots', 'configForms'] };
  }
});
