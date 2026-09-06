/* global window */
/**
 * dsh-hippo-memory — browser half.
 *
 * Contributes the "hippo-memory" plugin card to the Web GUI Plugins settings
 * section (设置 → 插件 → 插件配置). The card edits the `hippo-memory`
 * settings namespace registered by the host half of this package:
 *
 *   enabled       toggle — mounts/unmounts the memory tools, guidance section,
 *                 and digest context on the host (live)
 *   contextLimit  number — max digest items auto-injected per assembly
 *   sharedStore   toggle — share one store across sessions instead of one per
 *                 session (requires the host setting; per-agent store stays
 *                 the default)
 *
 * The card is a staged form: nothing writes until Save; Save writes one
 * revision-fenced mutation through the settings scope.
 *
 * Module format: browser client modules are `window.__ModuleLoader__.load`
 * bundles (the web shell's CJS-like facade). `@deepseek-ai/*` UI packages,
 * react and react/jsx-runtime resolve through the shell's static module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hippo-memory',
  factory: (require) => {
    'use strict';

    const React = require('react');
    const { jsx } = require('react/jsx-runtime');
    const cordis = require('@deepseek-ai/cordis');
    const storePkg = require('@deepseek-ai/dsh-client-store');

    const NS = 'hippo-memory';

    /* ------------------------------------------------------------------ */
    /* locale dictionaries (zh + en)                                       */
    /* ------------------------------------------------------------------ */

    const en = {
      title: 'HippoMemory',
      description: 'Hippocampus-inspired long-term memory: tools, guidance, and per-assembly digest for DSH agents.',
      expandLabel: 'Expand settings',
      collapseLabel: 'Collapse settings',
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
      title: 'HippoMemory 记忆',
      description: '海马体式长期记忆：为 DSH agent 提供记忆工具、使用纪律与每轮自动注入的记忆摘要。',
      expandLabel: '展开设置',
      collapseLabel: '收起设置',
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
            text: String(value.embedding ?? 'off'),
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
          available: snap.available !== false,
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

      let revision = scope.getSnapshot().revision ?? 0;
      return {
        store,
        edit(field, text) {
          draft[field] = { text, clear: false };
          notify();
        },
        toggle(field, current) {
          draft[field] = { text: String(!current), clear: false };
          notify();
        },
        resetField(field) {
          draft[field] = { clear: true };
          notify();
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
          try {
            await scope.mutate(ops, revision);
            draft = {};
          } finally {
            revision = scope.getSnapshot().revision ?? revision;
            notify();
          }
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

      const scope = ctx.settingsScope.bind({ namespace: NS });
      const form = createCardForm(scope);

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
        save: () => {
          form.save();
        },
        discard: () => form.discard()
      });

      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NS,
            locale: NS,
            inject: injected
          },
          Card
        );
      });
    }

    /* ------------------------------------------------------------------ */
    /* card component                                                      */
    /* ------------------------------------------------------------------ */

    const cardCss = `
.hm-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;transition:border-color .16s,background .16s;margin:0;padding:0}
.hm-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.hm-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.hm-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex;margin:0}
.hm-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.hm-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.hm-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.hm-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.hm-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.hm-chevronOpen{transform:rotate(180deg)}
.hm-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.hm-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
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

    const chevronPath = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';

    function Card(props) {
      const { t } = props;
      const state = props.useHippoMemory((snapshot) => snapshot);
      const [open, setOpen] = React.useState(false);
      if (!state || state.available === false) return null;
      const disabled = !state.writable;
      const invalidDraft = state.invalid === true;
      const label = open ? t('collapseLabel') : t('expandLabel');
      return jsx('li', {
        className: 'hm-card' + (open ? ' hm-cardOpen' : ''),
        children: [
          jsx('button', {
            type: 'button',
            className: 'hm-header',
            'aria-expanded': open,
            'aria-label': label + ': ' + t('title'),
            onClick: () => setOpen((v) => !v),
            children: [
              jsx('span', {
                className: 'hm-headText',
                children: [
                  jsx('span', {
                    className: 'hm-name',
                    children: [t('title'), state.dirty ? jsx('span', { className: 'hm-pending', children: t('dirty') }) : null]
                  }),
                  jsx('span', { className: 'hm-description', children: t('description') })
                ]
              }),
              jsx('svg', {
                width: '14',
                height: '14',
                viewBox: '0 0 14 14',
                fill: 'none',
                xmlns: 'http://www.w3.org/2000/svg',
                className: 'hm-chevron' + (open ? ' hm-chevronOpen' : ''),
                children: jsx('path', { d: chevronPath, fill: 'currentColor' })
              })
            ]
          }),
          open ? jsx('div', {
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
                        value: state.embedding ? state.embedding.text : 'off',
                        onChange: (e) => props.edit('embedding', e.target.value),
                        children: [
                          jsx('option', { value: 'off', children: 'off' }),
                          jsx('option', { value: 'auto', children: 'auto' })
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
          }) : null
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

    return { apply, inject: ['locale', 'slots', 'settingsScope'] };
  }
});
