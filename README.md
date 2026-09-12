# 🧠 HippoMemory

**受海马体机制启发的 AI Agent 长时记忆** —— 长会话不再忘事、不再幻觉。

[![npm](https://img.shields.io/npm/v/hippo-memory-core)](https://www.npmjs.com/package/hippo-memory-core)
[![npm](https://img.shields.io/npm/v/dsh-hippo-memory)](https://www.npmjs.com/package/dsh-hippo-memory)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-green)](package.json)

```
思考过程是易失的（工作记忆）
     ↓ 注意筛选
场景被绑定成 episode（海马 DG/CA3 稀疏编码）   ← remember()
     ↓ 线索驱动补全
只有与当前问题相关的痕迹被唤起（模式完成）    ← recall()
     ↓ 离线整理
高频情景被抽象成语义规则（系统巩固）          ← consolidate()
     ↓ 持续审计
有据可查才敢断言，查无实据就明说不知道（源监控）← sourceMonitor()
```

零外部服务：**SQLite（Node 内置）+ 进程内向量索引 + 可选嵌入模型**。
带单元测试与**反幻觉评测基准**（长会话：无记忆 0/8 答对 → 有记忆 8/8 答对，编造率 25% → 0%）。

---

## 📦 本仓库包含两个包

| 包 | 用途 | 安装 |
|---|---|---|
| [**`dsh-hippo-memory`**](packages/dsh-hippo-memory/README.md) | **DSH（DeepSeek Runtime）插件** —— 工具 + 自动注入 + 纪律 + GUI 设置卡片 | **DSH 用户装这个**：`dsh plugin --profile web add dsh-hippo-memory` |
| [**`hippo-memory-core`**](https://www.npmjs.com/package/hippo-memory-core) | 框架无关的记忆引擎（可用在任意 agent 框架） | `npm install hippo-memory-core` |

> 👉 **DSH 用户请直接看 [`dsh-hippo-memory` 说明](packages/dsh-hippo-memory/README.md)（安装 / 设置 / 用法 / FAQ）**，
> 或完整中文手册 [docs/USER-GUIDE.zh-CN.md](docs/USER-GUIDE.zh-CN.md)。
> **English speakers:** see [README.en.md](README.en.md).

---

## 🔧 引擎（hippo-memory-core）快速开始

> DSH 用户无需以下步骤——直接 `dsh plugin add dsh-hippo-memory` 即可。
> 以下面向：想在自己 agent 框架里用记忆引擎的开发者。

```bash
npm install
npm run build        # tsc → dist/
npm test             # 单元测试（node:test）
npm run bench        # 反幻觉基准：长会话 有/无 记忆对比
node examples/quickstart.mjs   # 可运行的用法演示
```

Node ≥ 22.5（使用内置 `node:sqlite`，无需安装 SQLite）。

---

## 怎么用（引擎 5 步标准用法）

引擎不绑定任何 agent 框架——它只负责"记忆库"，你在 agent 主循环的 5 个位置调用它：

```
用户/工具消息
   │
   ├─① remember()      ← 每学到一条事实/经历一件事，立刻写入
   │                      （生产环境：由 harness 或 LLM 从对话提炼 payload）
   │
   ├─② composeContext()← 组装本轮要注入 prompt 的记忆片段
   │                      （只放相关的几条，模拟工作记忆门控）
   │
   ├─③ [LLM 生成回答]
   │
   ├─④ sourceMonitor() ← 回答里凡涉及"记忆中的事实"，断言前先验证
   │                      substantiated=false → 改答"我不确定/记忆里没有"
   │
   └─⑤ 会话结束/定时  consolidate() + forget()
```

对应到代码（完整可运行版见 `examples/quickstart.mjs`）：

```js
import { HippoMemory } from 'hippo-memory-core';

// 0) 初始化：db 文件 = 长时记忆，重启后仍在
const mem = new HippoMemory({ dbPath: './agent-memory.db' });

// ① 写入：建议用结构化声明 "<主体> -> <值>"（能触发纠错覆盖机制）
await mem.remember({
  kind: 'semantic',
  summary: 'billing service database -> postgres',   // ← 箭头格式
  entities: [{ name: 'billing' }],
  source: 'user',          // 谁告诉你的（user/tool/config/llm…）
  confidence: 'high'
});
// 用户后来纠正 → 同一主体不同值 → 自动版本化覆盖，旧值进历史：
await mem.remember({
  kind: 'semantic',
  summary: 'billing service database -> mysql',
  source: 'user'
});
// ↑ 结果：原记忆 v1→v2，recall 只返回 mysql；history(id) 可查 postgres 曾存在

// ② 每轮组 prompt 片段：只放与当前目标相关的
const { context } = await mem.composeContext('fix billing connection', { limit: 5 });

// ④ 断言前验证（把结果交给 prompt 约束，或直接拦截回答）
const v = await mem.sourceMonitor('billing service database is postgres');
if (v.contradicted)    // 记忆里已有反证 → 别这么说
if (!v.substantiated)  // 查无实据 → 回答"记忆里没有这条"
```

**什么时候用什么**（三条 API 的分工，别混用）：

| 场景 | 用哪个 | 说明 |
|---|---|---|
| "当前任务需要哪些背景" | `composeContext` | 每次 LLM 调用前，结果拼进 system prompt |
| "某个具体问题/实体" | `recall` | 需要候选列表时（含 score/来源/版本） |
| "我要断言这句话，靠谱吗" | `sourceMonitor` | 回答中引用事实前，或对答案做后置校验 |
| "会话结束了/定期" | `consolidate` + `forget` | 离线整理：情景→语义规则；清理弱记忆 |

**两条最重要的使用纪律**（决定反幻觉效果）：

1. **写的时候带 `source` + `confidence`**——没有来源标记，源监控就无从谈起；
2. **`substantiated=false` 时必须让模型答"不知道"**，而不是顺着问题编——这是幻觉率归零的关键（评测里 no-memory 组 25% 幻觉正是少了这一步）。

---

## 核心 API

```ts
import { HippoMemory } from 'hippo-memory-core';

const mem = new HippoMemory({ dbPath: './agent-memory.db' });

// ── 写入（海马编码）：重复复述会强化；同实体冲突会版本化而非覆盖
await mem.remember({
  kind: 'episode',                            // episode | semantic | procedure
  summary: '用户把 billing 服务数据库从 postgres 迁移到了 mysql',
  episode: { place: 'workspace', time: '2025-06-01' },
  entities: [{ name: 'billing' }],
  source: 'user',                             // provenance
  confidence: 'high',                         // high|medium|low|speculative
  occurredAt: '2025-06-01T09:00:00Z'          // 真实事件时间（冲突窗口判定）
});

// ── 读取（线索驱动模式完成）
const { hits, warnings, reason, nearMisses } = await mem.recall(
  { query: 'billing 服务现在用什么数据库？', entities: ['billing'] },
  8
);
// 每个命中带三个分数，别再拿 score 当相似度看：
//   similarity    原始余弦 —— 与 similarityThreshold、与 sourceMonitor 同口径，可直接比较
//   score         排序分 = similarity × (0.6 + 0.4·importance)，上限 1.0
//   relativeScore similarity ÷ 本次最高 similarity（1.0 = 本次最佳）
// hits[0].similarity   // 0.62
// hits[0].score        // 0.545
// hits[0].relativeScore// 1
// hits[0].literalMatch // 命中的标识符 token 数（0x… / D-387 / commit sha）

// 空结果不是黑箱：reason 说明为什么没命中
if (hits.length === 0) {
  reason;       // 'below-threshold' 有相关记忆但没过门槛 | 'no-candidates' 库里没有或全被筛掉 | 'empty-cue'
  nearMisses;   // [{ id, summary, similarity }] 最接近的几条，一眼看出"差一点"的是哪条
}

// ── 断言前源监控（前额叶）：substantiated / contradicted / unsubstantiated
// 注意：这里报的是**原始余弦**（单条最佳 1-NN，不含重要性加权），
// 所以它的分与 recall 的 `similarity` 同口径，而不是 recall 的 `score`。
const v = await mem.sourceMonitor('billing 服务使用 postgres');
if (v.contradicted)        /* 记忆里有反证，别这么断言 */;
if (!v.substantiated)      /* 查无实据 → 回答"不知道"而非编造 */;

// ── 工作记忆门控：只把相关的几条约 memory 注入 prompt
const { context } = await mem.composeContext('修复 billing 迁移后的连接问题', { limit: 5 });

// ── 离线过程
await mem.consolidate();          // 系统巩固：情景 → 语义规则
mem.forget({ dryRun: true });     // 自适应遗忘（预览）
mem.history(id);                  // 版本历史（再巩固审计）
mem.duplicates();                 // 只读报告近似重复（跨 kind，忽略 "FACT: " 前缀），不删除
```

写入被版本化覆盖时，返回值会说明被替换掉的是哪一条：

```ts
const res = await mem.remember({ kind: 'semantic', summary: 'build cache -> disabled', entities: [{ name: 'cache' }] });
res.outcome;     // 'new' | 'none'（复述强化）| 'merge' | 'override'
res.superseded;  // 仅 override：{ id, version, summary } —— 旧版已存档，mem.history(id) 可查
```

### 选项

```ts
new HippoMemory({
  dbPath: './m.db',
  options: {
    nearDuplicateThreshold: 0.92,   // 余弦高于此 → 视为同一记忆
    contradictionThreshold: 0.86,   // 余弦高于此 → 视为"同事件、异声明"冲突
    similarityThreshold: 0.32,      // recall 最低余弦（默认 0.32；离线哈希嵌入对中文/短语的绝对余弦偏低，0.4 会误杀真实命中）
    minImportance: 0,               // recall 重要度下限
    topK: 20,
    forgetAfterSec: 60*60*24*120,   // 闲置多久可被遗忘
    maxVersionsPerId: 8             // 每条记忆保留的版本数
  }
});
```

### 接入真实嵌入模型（强烈推荐生产使用）

```ts
import { pipeline } from '@xenova/transformers';

const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
mem.setEmbedder({
  dim: 384,
  embed: async (texts) => (await extractor(texts, { pooling: 'mean', normalize: true })).tolist()
});
```

切换嵌入器后（例如哈希 → 模型），旧向量的语义空间不同，需一次性重嵌入历史记忆：

```ts
await mem.ensureEmbeddingMigration(); // 返回重嵌入行数；持久标记保证只跑一次
```

不设置时使用内置确定性特征哈希编码（同义词弱，仅供测试/演示）。

---

## 反幻觉评测（bench）

`bench/anti-hallucination-bench.mjs` 模拟一场"长工作会话"：

1. 会话早期埋入 8 条事实；
2. 中段 2 条事实被**用户更正**（必须答新值）；
3. 随后 60 轮无关噪声工作——把早期事实挤出有界上下文窗口；
4. 最后就 8 条事实提问，对比：
   - **无记忆**：只有最近 25 行可见（模拟有界窗口 LLM），无法识别陈旧声明；
   - **HippoMemory**：全量结构化记忆 + 版本化更正 + 查无实据拒答。

```bash
npm run bench
```

输出正确率 / 幻觉率 / 拒答率对比。仓库设计目标：**无记忆组幻觉率显著高于 HippoMemory 组，HippoMemory 组在"错误断言"上趋近 0**。

> 说明：no-memory 组用的是"尽力检索的代理"，真实 LLM 在窗口外问题上更倾向**编造**而非拒答——所以本基准给出的 no-memory 幻觉率是**乐观下限**，实际差距只会更大。

---

## 神经科学对应表

| 人脑机制 | 神经基础 | 插件实现 |
|---|---|---|
| 工作记忆容量限制 | 前额叶 ~4±2 chunks | `composeContext` 门控 |
| 海马情景绑定 | DG 稀疏编码 + CA3 | `remember` + episode 元数据 |
| 模式分离 | DG 颗粒细胞 | 近重复检测（余弦阈值） |
| 模式完成 | CA3 自联想网络 | `recall` 语义补全 |
| 再巩固（提取即改写） | 蛋白合成依赖窗口 | `update` 版本化 + 历史归档 |
| 系统巩固（睡眠重放） | 海马 → 新皮层 | `consolidate` episode → semantic |
| 源监控 | 前额叶 + 海马分离 | `sourceMonitor` 三值裁决 |
| 自适应遗忘 | 突触降标/神经发生 | `forget` 强度衰减 + 软删除 |

完整设计讨论见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 召回质量：分数、空结果与重复治理

### 为什么不能把 `score` 当相似度看

早期只暴露一个 `score`，于是出现过"`memory_verify` 给 0.604、`memory_recall` 只给 0.449，是不是 recall 更弱"的误判。其实是**两个口径**：

| 途径 | 报的数 | 含义 |
|---|---|---|
| `sourceMonitor(claim)` / `memory_verify` | 原始余弦 | 单条最佳 1-NN，**不含**重要性加权 |
| `recall().hits[].score` | `sim × (0.6 + 0.4·importance)` | 排序用，天然与余弦不同 |
| `recall().hits[].similarity` | **原始余弦** | 与上面第一行、与 `similarityThreshold` **同口径**，可直接比较 |

`memory_verify` 不是"更强的召回入口"：它只取单条最佳、不做重要性加权、也不给 provenance 列表——它是**断言前的是非裁决**，不是检索器。要对比就用 `similarity`。

### 空结果一定给得出理由

`recall()` 返回 `reason`，把"没找到"拆成可行动的情况：

| reason | 含义 | 该怎么办 |
|---|---|---|
| `ok` | 有命中 | — |
| `below-threshold` | 有相关记忆，但都没过 `similarityThreshold` | 看 `nearMisses` 判断是"真没有"还是"门槛偏高" |
| `no-candidates` | 库里没有，或全被结构筛选（kind/entities/重要性/时间）滤掉 | 确认筛选条件是否过严 |
| `empty-cue` | 没给 query（如首轮渲染） | 返回最近更新记忆兜底 |

配套字段：`eligible`（通过结构筛选的条数）、`bestSimilarity`（这批里最高的原始余弦）、`threshold`（本次生效门槛）、`nearMisses`（最接近的几条，含分值与摘要）。

### 标识符查询：为什么"精确 token 命中"要压过余弦

裸标识符（`0x6070`、`D-387`、commit sha、版本号）做嵌入查询时余弦极低——短中文 query 尤其明显。但**精确 token 命中是比余弦更强的证据**。因此当 query 与记忆共享标识符时，该条即使低于门槛也会被召回，命中里标 `literalMatch`（共享 token 数）并获排序加成。

生产库（167 条记忆）实测，277 条标识符查询：

| | Top-1 命中率 | MRR |
|---|---|---|
| 无字面加权 | 10.5% | 0.195 |
| 有字面加权 | **99.6%** | **0.998** |

`similarity` 始终是真实余弦，加权只影响召回与排序。

### 重复从哪来、怎么清

主要来源是**整合本身**：`consolidate()` 把 episode 抽象成规则时，规则正文可能与 episode 完全相同、只多一个 `FACT: ` 前缀，于是两条并存。写入路径的跨类型合并现已统一剥离该前缀，重述会正确并入原记忆。

已存在的重复用只读报告查看（**不会删任何东西**）：

```ts
mem.duplicates();
// { scanned, groups: [{ key, memories: [{ id, kind, version, summary }] }] }
```

确认后再用 `delete(id)` 逐条清理（注意：会连版本历史一起删，不可恢复）。

---

## 诚实边界

本引擎**根治的是"记忆性幻觉"**（长上下文导致的事实遗忘/混淆/陈旧/编造）。它**不解决**：

- 模型参数知识本身的错误（需要工具/RAG/知识图谱）；
- 纯解码随机性导致的胡言（需要采样控制）；
- 需要跨进程共享记忆的场景（当前为单进程 SQLite，MCP 化是下一步）。

且与人脑一样，本系统**允许遗忘与重构**——它保证"凡断言有据、无据则明说"，不保证"永不犯错"。

## License

MIT
