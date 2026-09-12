# HippoMemory 架构：受海马体启发的 Agent 长时记忆

> 为什么"线性上下文"会让 Agent 记忆力混乱，以及本插件如何用人脑的分层方案根治它。

---

## 1. 问题：长会话记忆混乱的根源

现代 LLM agent 的默认做法是**把完整会话历史线性堆进 context window**。从认知架构的角度看，这等于让一个系统同时兼任：

- 工作记忆（当前任务相关的少量信息）
- 长时存储（全部历史事实）
- 检索索引（在历史中找答案）
- 源监控器（判断"我经历过" vs "我生成过"）

人脑在演化上**刻意把这几件事分给了不同结构**（前额叶 / 海马 / 新皮层），因为合在一起会出问题：

| 症状 | 机制（人脑类比） | 后果 |
|---|---|---|
| 越聊越糊涂 | 工作记忆超载（PFC 容量 ~4±2 chunks） | 注意力稀释，早期事实被"挤出去" |
| 相似记忆互相污染 | 模式分离（DG 稀疏编码）缺失 | 两个相似但不同的配置被混为一谈 |
| 旧信息覆盖新信息 | 冲突无法解决（无再巩固） | 会话中段的纠错被早先的事实"淹没" |
| 编造不存在的细节 | 源监控（PFC）缺失 | 模型把"自己生成的"当"真实发生过的" → 幻觉 |
| 垃圾占满检索空间 | 无遗忘机制 | 无关历史干扰检索 |

LLM 的"记忆混乱 → 幻觉"主要是**架构性**的：不是模型参数不够好，而是没有给模型一个"有据可查 / 查无实据"的分层记忆系统。

---

## 2. 神经科学 → 工程映射

| 人脑机制 | 神经科学要点 | 插件组件 | 文件 |
|---|---|---|---|
| 工作记忆门控 | PFC 只保留任务相关的 4±2 项 | `composeContext(goal, limit)` | `memory.ts` |
| 海马编码 | 稀疏绑定：事件 = 项目 + 时间 + 地点 | `remember({kind, summary, episode, occurredAt})` | `memory.ts` |
| DG 模式分离 | 相似事件映射到不同神经元子集 | 余弦近重复检测 → 不重复存储 | `memory.ts` |
| CA3 模式完成 | 部分线索补全完整记忆 | `recall(cue)` 语义检索 | `memory.ts` |
| 再巩固 | 提取/更新时记忆回到不稳定状态，旧痕迹被归档而非删除 | `update()` 版本化 + 历史归档 | `sqlite.ts` |
| 系统巩固 | 睡眠中 海马→新皮层 抽象 | `consolidate()` 情景→语义规则 | `memory.ts` |
| 前额叶源监控 | 区分真记得/觉得记得/编造 | `sourceMonitor(claim)` 三值裁决 | `memory.ts` |
| 遗忘曲线 | Ebbinghaus 衰减 | `forget()` 强度衰减 + 软删除 | `memory.ts` |
| 情节绑定 | Papez 环 时间+地点+人物 | episode 元数据字段 | `schema.ts` |

---

## 3. 数据模型

```
engram (一条记忆痕迹)
├─ id            （UUID；"记忆细胞集合"的身份）
├─ version       （再巩固版本号：1,2,3…）
├─ kind          episode | semantic | procedure
│                  └ 情景记忆（海马）  └ 语义记忆（新皮层化）  └ 程序记忆（基底节类比）
├─ summary       ← LLM 优先消费的紧凑声明
├─ detail        ← 原始细节（供深度回顾）
├─ episode {time, place, participants}
├─ entities[] / tags[]
├─ occurredAt    ← 真实世界事件时间（用于冲突窗口判定）
├─ source        ← 来源（user | tool | config | llm 自生成）——源监控的原料
├─ confidence    ← high/medium/low/speculative（写者可信度）
├─ importance / accessCount / lastAccessAt   ← 巩固与遗忘的原料
└─ vec           ← 编码向量（语义指纹）

memory_history（每次 update/override 自动归档旧版本 → 可审计、可回滚）
```

一条"记忆"就是一个带版本历史的 engram；同 id 的 v1/v2 反映**同一件事的演化**（再巩固），不同 id 的高相似反映**不同的相似事件**（模式分离要保留的正是差异）。

---

## 4. 写入路径：remember()

```
新输入 payload
   │
   ├─ 1. 归一化：summary 规范化 → 提取实体/标签 → 计算编码向量
   │
   ├─ 2. DG 模式分离扫描：与现存痕迹逐一算余弦
   │
   ├─ 3. 判定
   │      ├─ 同 id/同声明复述        → 强化 importance（rehearsal）
   │      ├─ 跨类型重复（episode 复述 semantic） → merge 进 semantic
   │      ├─ 高相似 + 同实体 + 同事件窗口 + 异声明 → override（版本 +1，旧版归档）
   │      └─ 其余                       → 新建痕迹
```

关键点：**冲突不静默覆盖**。`update()` 先把当前版本快照写入 `memory_history`，再落新版本——这对应再巩固的"先回到不稳定、再重写"，也让 agent 永远能回答"这个结论是什么时候从什么改来的"。

---

## 5. 读取路径：recall() / sourceMonitor() / composeContext()

```
提问/当前目标
   │
   ├─ recall(query, {entities, since, kind, excludeIds})
   │      语义相似 × importance 加权排序
   │      → 命中带 provenance（source/confidence/version/occurredAt）
   │      → 每个命中三个分数：similarity（原始余弦）/ score（加权）/ relativeScore（本次相对）
   │      → 标识符精确命中（0x… / D-387 / sha）即使低于阈值也召回，标 literalMatch
   │      → 冲突警告：同实体域存在更新的版本时提示（防陈旧事实）
   │      → 空结果可解释：reason + eligible + bestSimilarity + threshold + nearMisses
   │
   ├─ sourceMonitor(claim)      ← 断言前的"前额叶检查"
   │      ├─ SUBSTANTIATED（有证据）
   │      ├─ CONTRADICTED（有反证——注意否定词启发式）
   │      └─ UNSUBSTANTIATED（查无实据 → 明确告诉 agent：说不存在/不知道，禁止编）
   │
   └─ composeContext(goal)      ← 给 prompt 的工作记忆片段
         目标相关 top-K + 可选最近 N 条，逐条带 [kind/source/conf/vN] 标签
```

三者的分界很重要：
- **recall 负责"把可能相关的找出来"**——召回；
- **sourceMonitor 负责"这条能不能断言"**——准确性的守门员；
- **composeContext 负责"现在该把哪几条放进窗口"**——工作记忆门控，防超载。

### 分数口径必须区分（易错点）

两条路径报的数**不是同一个量**，混着比会得出错误结论：

| 路径 | 报的数 | 是否含 importance 加权 |
|---|---|---|
| `sourceMonitor(claim)`（= `memory_verify`） | 单条最佳 1-NN 的**原始余弦** | 否 |
| `recall().hits[].score` | `similarity × (0.6 + 0.4·importance)` | 是 |
| `recall().hits[].similarity` | **原始余弦** | 否（与第一行同口径） |

因此 `sourceMonitor` **不是**"更强的召回入口"：它只取单条最佳、不做重要性加权、也不返回 provenance 列表。它是断言前的是非裁决，不是检索器。要跨工具比较，用 `similarity`。

---

## 6. 离线过程：consolidate() / forget()

```
consolidate(定期/会话结束调用)
  对每个"稳固"的 episode（accessCount≥3 或 importance≥0.6）：
    提取语义规则 → 若不存在等价 semantic 则新建（detail 记录源自哪个 episode）
  效果：长会话后，高频情景被压成少数几条语义规则，
        回答"一般性问题"时命中更紧凑、更不易受噪声干扰。
  （多重痕迹立场：episode 保留，可回答"何时/何地"）

forget(定期调用)
  强度 = importance × (0.5 + 0.5·min(1, access/5))
  强度 < floor：
    闲置超阈值 → 软删除（superseded=1，历史保留）——对应"遗忘但不毁灭"
    未超阈值 → importance × 0.9 衰减（Ebbinghaus 式）
  dryRun 可预览。
```

---

## 7. 反幻觉保障：为什么这样能压住"记忆性幻觉"

幻觉分三类，本插件针对第一类：

| 幻觉类型 | 成因 | 插件措施 |
|---|---|---|
| **记忆性幻觉**（本插件解决） | 历史事实被遗忘/混淆/陈旧/编造 | 结构化写入 + 版本化 + 来源标记 + 三值裁决 + 拒绝回答 |
| 参数性幻觉 | 模型训练知识本身错误 | 无法由记忆层解决（需要工具/RAG/知识图谱） |
| 解码性幻觉 | 采样随机性 | 无法彻底解决，可降温度/约束解码 |

诚实边界：插件不提升模型"懂得更多"，它保证的是——
1. **凡断言必有据**（来源、版本、时间可追溯）；
2. **查无实据就明说不知道**（UNSUBSTANTIATED → 显式拒答，而不是脑补）；
3. **新旧冲突浮出水面**（recall 警告 + sourceMonitor 反证），而不是让模型二选一赌。

这正是人脑的做法：海马损伤患者会"记不起"而不会系统性"编出"；前额叶受损才虚构。**把"不知道"变成第一类响应**，是压低幻觉最有效、也最符合神经机制的一招。

---

## 8. 集成指南（伪代码）

```ts
import { HippoMemory } from 'hippo-memory-core';

const mem = new HippoMemory({ dbPath: './agent-memory.db' });

// ① 每个回合：把新发生的事写进去（由 agent 或 harness 生成结构化 payload）
await mem.remember({
  kind: 'episode',
  summary: '用户确认使用 MySQL 作为 billing 数据库',
  entities: [{ name: 'billing' }],
  source: 'user', confidence: 'high'
});

// ② 每个回合：用当前目标组装注入 prompt 的记忆片段
const { context } = await mem.composeContext(currentGoal, { limit: 6 });

// ③ 回答前：凡涉及记忆事实的断言先过一遍源监控
const verdict = await mem.sourceMonitor('billing 使用 MySQL');
if (!verdict.substantiated) {
  // 返回 "我记不起/不确定"，而不是编一个
}

// ④ 会话结束/定时：巩固 + 遗忘
await mem.consolidate();
mem.forget({ dryRun: true });
```

---

## 9. 已知局限与路线图

- **嵌入质量**：默认的 feature-hash bag-of-words 是同义词弱的粗糙相似度。生产环境应 `setEmbedder()` 接入真实嵌入模型（Transformers.js / OpenAI / 本地 ONNX）——接口已预留，不影响其他逻辑。
- **语义规则提取**：`consolidate()` 目前用规则模板抽象；真正的"事件 → 可泛化知识"应由 LLM 离线摘要完成（给 `HippoMemory` 一个 `summarizer` 回调即可，当前为朴素实现）。
- **否定与反事实**：`sourceMonitor` 用否定词启发式判断矛盾，对"并非所有 X 都是 Y"这类量词否定会误判——需要真实语义模型。
- **多 agent / 共享记忆**：当前单进程 SQLite；跨进程共享需加锁或换 server（MCP 化是自然下一步）。
- **情感/情绪标签**：人脑记忆强度受杏仁核调制；agent 版可用"用户强调程度"近似，暂未实现。

架构以"诚实性 > 召回率"为第一原则：宁可拒答（refuse），不可编造（confabulate）。
