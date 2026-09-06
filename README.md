# 🧠 HippoMemory

> 📦 **包名已更名**：`hippo-memory`（npm 已被他人占用）→ **`hippo-memory-core`**。
> 使用 DSH 的最终用户请安装适配层 [**`dsh-hippo-memory`**](packages/dsh-hippo-memory/README.md)（含 GUI 设置卡片）。

**受海马体机制启发的 AI Agent 长时记忆引擎** — 专门针对"长时间工作会话中，上下文过长导致记忆混乱、进而产生幻觉"的问题。

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
带单元测试与**反幻觉评测基准**（对比"纯长上下文"与"本插件"在长会话下的幻觉率）。

---

## 快速开始

```bash
npm install
npm run build        # tsc → dist/
npm test             # 单元测试（node:test）
npm run bench        # 反幻觉基准：长会话 有/无 记忆对比
node examples/quickstart.mjs   # 可运行的用法演示
```

Node ≥ 22.5（使用内置 `node:sqlite`，无需安装 SQLite）。

---

## 怎么用（5 步标准用法）

插件不绑定任何 agent 框架——它只负责"记忆库"，你在 agent 主循环的 5 个位置调用它：

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
const { hits, warnings } = await mem.recall(
  { query: 'billing 服务现在用什么数据库？', entities: ['billing'] },
  5
);

// ── 断言前源监控（前额叶）：substantiated / contradicted / unsubstantiated
const v = await mem.sourceMonitor('billing 服务使用 postgres');
if (v.contradicted)        /* 记忆里有反证，别这么断言 */;
if (!v.substantiated)      /* 查无实据 → 回答"不知道"而非编造 */;

// ── 工作记忆门控：只把相关的几条约 memory 注入 prompt
const { context } = await mem.composeContext('修复 billing 迁移后的连接问题', { limit: 5 });

// ── 离线过程
await mem.consolidate();          // 系统巩固：情景 → 语义规则
mem.forget({ dryRun: true });     // 自适应遗忘（预览）
mem.history(id);                  // 版本历史（再巩固审计）
```

### 选项

```ts
new HippoMemory({
  dbPath: './m.db',
  options: {
    nearDuplicateThreshold: 0.92,   // 余弦高于此 → 视为同一记忆
    contradictionThreshold: 0.86,   // 余弦高于此 → 视为"同事件、异声明"冲突
    similarityThreshold: 0.4,       // recall 最低余弦
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

## 诚实边界

本插件**根治的是"记忆性幻觉"**（长上下文导致的事实遗忘/混淆/陈旧/编造）。它**不解决**：

- 模型参数知识本身的错误（需要工具/RAG/知识图谱）；
- 纯解码随机性导致的胡言（需要采样控制）；
- 需要跨进程共享记忆的场景（当前为单进程 SQLite，MCP 化是下一步）。

且与人脑一样，本系统**允许遗忘与重构**——它保证"凡断言有据、无据则明说"，不保证"永不犯错"。

## License

MIT
