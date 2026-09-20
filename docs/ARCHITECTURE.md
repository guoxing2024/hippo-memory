# HippoMemory 架构：受海马体启发的 Agent 长时记忆

> 为什么线性上下文会让 Agent 的记忆混乱，以及本插件如何用人脑的分层方案根治它。
> 版本：引擎 `hippo-memory-core` 0.3.0 / 适配层 `dsh-hippo-memory` 0.3.0（已发布到 npm）

---

## 1. 问题：长会话记忆混乱的根源

现代 LLM agent 的默认做法是**把完整会话历史线性堆进 context window**。从认知架构的角度看，这等于让一个系统同时兼任：

- 工作记忆（当前任务相关的少量信息）
- 长时存储（全部历史事实）
- 检索索引（在历史中找答案）
- 源监控器（判断我经历过 vs 我生成过）

人脑在演化上**刻意把这几件事分给了不同结构**（前额叶 / 海马 / 新皮层），因为合在一起会出问题：

| 症状 | 机制（人脑类比） | 插件的对应措施 |
|---|---|---|
| 早期结论被挤出窗口 | 工作记忆超载（PFC 容量 ~4±2 chunks） | `composeContext` 只注入相关的几条 |
| 相似事件互相污染 | 模式分离失效（DG 稀疏编码） | 近重复检测 + 主张级复检 |
| 两个相似但不同的事被混为一谈 | 模式完成过度泛化 | 实体 + 时间窗口 + 双口径门 |
| 旧结论覆盖新信息 | 再巩固固着 | `override` 版本化 + 历史归档 |
| 错被早先的事实淹没 | 缺乏分歧检测 | `newer_related[]` / `stale_support` |
| 分不清真记得还是编的 | 源监控（PFC）缺失 | `sourceMonitor` 三值裁决 + 证据等级 |
| 垃圾占满窗口 | 无遗忘机制 | `forget` 强度衰减 + `compress` 压缩 |

LLM 的记忆混乱主要是**架构性**的：不是模型参数不够好，而是没有给模型一个可查证、可追溯、可遗忘的分层记忆系统。

---

## 2. 神经科学 → 工程映射

| 人脑机制 | 神经科学要点 | 插件组件 | 文件 |
|---|---|---|---|
| 工作记忆门控 | PFC 只保留任务相关的 4±2 项 | `composeContext(goal, {limit})` | `src/memory.ts` |
| 海马编码 | 稀疏绑定：事件 = 项目 + 时间 + 地点 | `remember({kind, summary, episode, occurredAt})` | `src/memory.ts` |
| DG 模式分离 | 相似事件映射到不同神经元子集 | 余弦近重复检测 + 实体闸门 | `src/memory.ts` |
| 编码特异性 | 同一内容在不同语境下算不同的一次记忆（Tulving） | `scope` 前提门：前提冲突则并存不覆盖，verify 答 `OUT_OF_SCOPE` | `src/memory.ts` |
| CA3 模式完成 | 部分线索补全完整记忆 | `recall(cue)` / `composeContext` | `src/memory.ts` |
| 再巩固 | 提取/更新时旧痕迹被归档而非删除 | `update()` / `override` 版本化 + `memory_history` | `src/sqlite.ts` |
| 定向重评 | 回忆后对特定痕迹做受控更新 | `supersedes` 显式纠正边（`superseded_by` 列） | `src/sqlite.ts` |
| 系统巩固 | 睡眠中 海马→新皮层 抽象 | `consolidate()` episode → semantic | `src/memory.ts` |
| 图式化 | 多条同域经验压缩为一条模式 | `proposeCompressions()` / `compress(plan)` / `undemote()` | `src/memory.ts` |
| 前额叶源监控 | 区分真记得 / 觉得记得 / 编造 | `sourceMonitor(claim, {scope})` 裁决 + 邻域证据 | `src/memory.ts` |
| 元认知 | 知道自己不知道 | `[ASSERTED]` 标记、低置信召回警告 | `src/memory.ts` |
| 前瞻记忆 | 未来情境 → 到时的行动 | `guard{trigger, action}` → `[GUARD]` 注入 | `src/memory.ts` |
| 遗忘曲线 | Ebbinghaus 衰减 + 间隔依赖 | `forget()` 强度衰减、`accessCount`、间隔加权复述 | `src/memory.ts` |
| 情节绑定 | Papez 环：时间 + 地点 + 人物 | episode 元数据 | `src/schema.ts` |
| 免疫（类比） | 对"被劫持的输入"做拦截 | 注入护栏 `sanitizeMemoryText` / `dataFrame` | `src/guard.ts` |

---

## 3. 数据模型

```
engram（一条记忆痕迹）
├─ id            UUID，痕迹身份（"记忆细胞集合"）
├─ version       再巩固版本（1,2,3…）
├─ kind          episode（海马情景）| semantic（新皮层规则）| procedure（技能）
├─ summary       LLM 优先消费的紧凑声明
├─ detail        原始细节（供深度回顾，也参与内容向量）
├─ episode {time, place, participants}
├─ entities[] / tags[]
├─ occurredAt    真实世界事件时间（冲突窗口判定）
├─ source        来源 user|tool|config|agent —— 源监控的原料
├─ confidence    high|medium|low|speculative（写者可信度）
├─ importance    0..1（显式声明优先，否则由 confidence 推导）
├─ accessCount / lastAccessAt    巩固与遗忘的原料
├─ verify {cmd, expect, artifact} + verifyResult + verifiedAt   可复算的出处
├─ retracts      撤回指针（指向被撤回的行）
├─ guard {trigger, action}       前瞻守卫
├─ superseded / supersededBy     退休标记与纠正边
├─ demoted / demotedTo           图式压缩折叠标记
├─ scope           前提作用域（key=value 段）：这句话在什么条件下成立
└─ vec           编码向量（语义指纹）

memory_history（每次 update / override 自动归档旧版本 → 可审计、可回滚）
```

一条记忆就是一个带版本历史的 engram；同 id 的 v1/v2 反映**同一件事的演化**（再巩固），不同 id 的高相似反映**不同的相似事件**（模式分离要保留的正是差异）。

**存储**：SQLite（`node:sqlite`，WAL 模式）。`memories` + `memory_history` 两张表；0.2.0 新增列（`superseded_by`、证据字段、`retracts`、`guard`、`demoted`）通过 `ALTER TABLE` 原地补列，**旧库零迁移**（下一版的 `scope` 走同一条 `ensureColumns()` 路径）。连接统一带 `PRAGMA busy_timeout`（默认 5000ms，`busyTimeoutMs` 可配），共享库多 agent 并发写不再直接抛 `SQLITE_BUSY`。store 懒打开：只读流量不落盘，首次写入才创建 `.db`；`pruneEmptyStores()` 清扫历史版本留下的空文件。

---

## 4. 写入路径：remember()

```
新输入 payload
   │
   ├─ 1. 归一化：summary 规范化 → 实体/标签 → 计算编码向量
   │            （contentText = summary + detail + place/time + rule + guard + scope + entities）
   │
   ├─ 2. 展开已装载候选：top-K 相似（含向量维度一致性检查）
   │
   ├─ 3. 五路判定（按优先级）：
   │     ├─ 逐字复述（同 kind 相同文本）           → none（强化 importance / access）
   │     ├─ 跨类型零新信息复述（episode 复述规则） → merge（剥离 "FACT: " 前缀后比较）
   │     ├─ 同主体换值（路径 0 / 路径 3）          → override（版本 +1，旧版归档）
   │     ├─ 显式纠正（payload.supersedes: [id]）   → supersede（旧行退役，新行接管）
   │     └─ 其余                                   → new
   │
   ├─ 4. 守卫（over 覆盖判定）：
   │     ├─ 证据门：新鲜 VERIFIED 的行只能被 passing 证据退休 → 否则 shielded:
   │     ├─ 主张门：content 余弦过线但 summary 主张余弦不过 → new + withheld-contradiction:
   │     ├─ 前提门：双方共有的 scope key 取值不同 → 不覆盖不合并 → new + different-scope:
   │     ├─ 实体闸门：只撞主体键、没撞实体 → 保护，列进 scope_only_matches
   │     ├─ 多行歧义：同主体多行未指名 → 新增 + not-overridden:
   │     └─ 值域先验：负熵 / 百分号越界 / 0..1 超界 → 只警告不拦截
   │
   └─ 5. 回显：outcome / id / version / scope / superseded / neighbours[] / warning / scope_only_matches
```

**核心不变量：冲突不静默覆盖。** 每一次退役都会说明退役了谁；每一次覆盖都会返回被替换的 id / 版本 / 摘要（旧版进 history）。这是 0.2.0 的设计主线——实测反馈里唯一会造成**数据丢失**的事故就是无 warning 的静默覆盖。

### 4.1 覆盖判定：为什么是双口径门

覆盖（`override`）的候选条件在 0.2.0 收紧为**两道门同时过**：

| 门 | 量 | 默认阈值 | 作用 |
|---|---|---|---|
| 内容门 | contentText（summary + detail）余弦 | `contradictionThreshold` 0.86 | 判断"是不是在说同一件事" |
| 主张门 | summary-to-summary 余弦 | `claimThreshold` 0.75 | 判断"是不是同一个主张" |

只看内容门会出事：一条长 detail 能把 content 向量推到 0.86 以上，而两条 summary 说的其实是**无关的两个主张**——这就是实测中的静默覆盖事故（BUG-1 及其复发）。主张门是第二道闸：summary 短，一个否定词在 summary 向量里权重更大，因此**真否定**能过 0.75（实测 0.80 / 0.95），而"话题相邻但主张无关"的一对过不了（实测 0.00 / 0.6995）。

不过主张门时**不覆盖**，降级为 `new` 并附 `withheld-contradiction:` 警告（含两个分值）。取舍是刻意的：**多存一行 vs 丢一条数据**——选多存一行。

### 4.2 强化是间隔加权的

复述不再恒 `+0.03`，而是按距上次访问的间隔对数加权：

```
boost = 0.01 + 0.03·log2(1 + 间隔天数)     （上限 0.12）
```

这是 Bjork"合意困难"（desirable difficulty）的工程化：**集中重复几乎无增益，间隔重复增益大**。读取路径同样参与（提取练习 / 测试效应，boost × 0.5）——被 `recall` 真正命中的记忆小幅升权，被动出现在 digest 里不算。加上 `memory_remember` 的显式 `importance` 参数，重要性从"恒 0.70 的死参数"变成三个通道共同驱动的活信号。


### 4.3 证据、撤回、前瞻

- **证据**：`verify {cmd, expect, artifact}` + `verifyResult` + `verifiedAt`。引擎**从不执行命令**，只存档 + enforcement：数字主张句（箭头 / 系表）无 passing 证据 → 降级存 episode（`downgraded:` 注记）；渲染按 `evidenceTtlSec`（默认 30 天）区分证据等级。**信任分级（二轮审计 #5）**：`verifyAttested: true`（调用方声明检查实际执行过）才有完整 `[VERIFIED]` 与退休护盾；默认的自报 pass 渲染 `[VERIFIED self-reported]`，护盾降级为显式警告——引擎不能让一个无法复核的徽章守护数据。
- **撤回**：`retracts: <id>` + `tags: ["retraction"]`，撤回行永不被覆盖；命中被撤回 id 的行渲染 `[retracted: …]` 且排序置顶。
- **前瞻守卫**：`guard {trigger, action}` + `tags: ["guard"]`；cue 命中触发词即注入 `[GUARD]`。

### 4.4 前提门：换口径的重测不是同一句话

双口径门回答的是"是不是同一个主张"，前提门回答的是更细的一层：**是不是同一个条件下的同一个主张**。外部实测反馈（P0-1b）里的原案例——`P(X==disp) ≈ 独立性基线` 在"记录落在指令起点"口径下为真、在"读记录自带 `disp`"口径下为假（后者 0.84388，n=2,466）——两句都是好结论，坏的是它们共用一行。

比较过程是**结构化**的（`src/memory.ts` 里 `scopeTokens` / `scopePairs` / `scopeValuesCompatible` / `scopeDifferences`）：

| 步骤 | 规则 | 为什么这样定 |
|---|---|---|
| 解析 | `;` / `,` / 换行分段，`=` 或 `:` 分键值 → `key → 词集合` | 让 agent 随手写的一行条件也能被比较 |
| 词法 | 小写；latin / 数字整段成词；**CJK 逐字成词**；剔英文停用词 | 与嵌入器**刻意不同**：`tokenize()` 把一串中文当成一个词，任何改写都会零重叠、被误判成新前提，比较要的是更细的粒度 |
| 取交集 key | 只比双方**都点名**的 key | 多写一个条件是补充信息，不是反对 |
| 值兼容 | 一方词集包含另一方，或交并比 ≥ 0.5（内部常数，非可调项）；任一侧为空 → 兼容 | 换措辞的前提不该被读成新前提；"没写"永远不等于"不同意" |

**不新增相似度阈值**：`diagnostics().thresholds` 里的数一个都没变，前提判定不发生在余弦上，因此不会和主张门互相重叠、也不需要用户调参。

开火点覆盖写入路径的四个分支（结构化声明、逐字最近、跨类型合并、近矛盾覆盖 / `shielded` / `brink`）：任一分支遇到前提冲突都不再并入或退休那一行，冲突行汇入一条 `different-scope:` 警告（同一 id 只计一次）。反过来，**存量行缺前提而重述带了前提**时走 `premiseFill()`——把前提补到原行，而不是另起一行，否则"补注条件"这种好事反而制造重复。

### 运行时绑定（0.2.1 起：Node 与 Bun）

`src/sqlite-runtime.ts` 把"用哪个 SQLite 驱动"从**编译期**（静态 import）推迟到**运行时**（探测 + 惰性 require）：

```
加载期：globalThis.Bun 是否存在？
  ├─ 无 → node:sqlite   （Node ≥ 22.5）
  └─ 有 → node:sqlite 能 load 吗？
          ├─ 能 → node:sqlite （Bun ≥ 1.4 实现了该内置模块）
          └─ 不能 → bun:sqlite（Bun 1.1–1.3：Database 包装成 DatabaseSync 最小同构面）
```

为什么必须这样做：静态导入的说明符要在**加载期**解析，`node:sqlite` 在 Bun 1.3 上直接抛 `No such built-in module` —— 这个错误发生在模块图求值阶段，**catch 不到、也没有垫片能介入**（除非先打包 + 别名替换）。惰性加载后，导入任何运行时都不抛错，只有真正 open() 时才会因为缺少驱动而报错，且错误信息给出可执行的建议。

两个驱动在**开库时都会因为父目录不存在而报 `unable to open database file`**，所以 `openStore()` 会先 `mkdir -p` 目标目录——新项目 / 新宿主第一次跑不再需要人工建目录。

---
## 5. 读取路径：recall() / sourceMonitor() / composeContext()

```
提问 / 当前目标
   │
   ├─ recall(query, {entities, since, kind, excludeIds, includeDemoted})
   │      语义相似 × importance 加权排序
   │      → 命中带 provenance（source/confidence/version/occurredAt/scope/verify/guard）
   │      → 三个分数：similarity（原始余弦）/ score（加权）/ relativeScore（本次相对）
   │      → 标识符精确命中（0x… / D-387 / sha）即使低于阈值也召回，标 literalMatch
   │      → 冲突警告：三通道任一即触发（极性相反 / 共享实体 / claimParts 同主体改值）
   │      → nearDuplicates：本次命中集内互相近似复述的行（不是冲突）
   │      → 空结果可解释：reason + eligible + bestSimilarity + threshold + nearMisses
   │
   ├─ sourceMonitor(claim, {scope})   ← 断言前的"前额叶检查"
   │      ├─ SUBSTANTIATED（有证据）
   │      ├─ CONTRADICTED（有反证 / 有更新版本）
   │      ├─ OUT_OF_SCOPE（最接近的那条属于别的前提 → 既不赞成也不反对）
   │      └─ UNSUBSTANTIATED（查无实据 → 明确告诉 agent：回答"不知道"，禁止编）
   │      邻域证据：contradicting[] / newer_related[] / superseded_matches[] / stale_support
   │      带 scope 时：过门槛候选按"前提一致 > 无前提 > 前提冲突"重排，再把余弦当次级键
   │      （判 TRUE/FALSE 之前先确认在比同一件事；前提冲突在否定词启发式**之前**返回）
   │
   └─ composeContext(goal, {limit, includeRecent, lowConfidenceTop1})   ← 给 prompt 的工作记忆片段
          相关 top-K + 最近写入尾巴（[recent]），逐条带 [kind|source|conf|vN] 标签，
          带前提的行再打 [scope: …]，整体包一层 [memory data] 数据框架，逐条过注入护栏清洗
          零命中且 reason=below-threshold 时：把最接近的那条作为第 1 行给出，标
          [low-confidence sim X < floor Y: the closest trace, not a memory — verify before asserting]，
          不借用原行的 [VERIFIED]/[ASSERTED]（items[].lowConfidence=true 供程序侧判断），
          并附一条 warning 说明这块里有一行是猜测。相似度为 0 / 空库 / 显式关掉时不给猜。
          零命中不再回填 [recent]：失败要看起来像失败。
```

三条路径的职责边界：

- **recall 负责"可能相关的有哪些"**——候选列表 + 分数 + provenance；
- **sourceMonitor 负责"这句断言站得住吗"**——是非裁决（不是检索器）；
- **composeContext 负责"现在该把哪几条放进窗口"**——工作记忆门控，防超载。

### 5.1 出口统一过注入护栏

记忆正文最终要回到 LLM 上下文，而 agent 读过的恶意网页可能已把"ignore all previous instructions"类文本写进了库——这会变成**每轮注入的持久化投毒**。因此在渲染出口统一生效（`src/guard.ts`）：

| 出口 | 清洗 | 数据框架 |
|---|---|---|
| `composeContext`（digest） | 逐条清洗 + 截断（`MAX_CONTEXT_TEXT` 600 字符） | ✅ 整体包裹 `[memory data …]` |
| `recall`（hits / nearMisses / conflict 警告） | ✅，并附 `injection:` 警告 | — |
| `sourceMonitor`（support / contradiction / 邻域证据） | ✅，note 标 `[injection: …]` | — |
| `memory_maintain`（list / history / duplicates / merge / override-audit） | ✅，list 附 `injectionWarnings` | — |

**存储行永不被改写**（审计轨迹完整）。规则刻意保守：只匹配"试图改变读者指令"的四类短语（指令劫持 / 人设接管 / 外传密钥 / 隐瞒用户），合法提及指令的记忆不受影响。

> 上表说的是**引擎出口**。适配层自己拼的工具结果是另一层：DSH 每个出口都过 `sanitizeMemoryText`；opencode 只有自动 digest 加 `duplicates` / `merge` 报告过清洗，其 `list` / `history` / `recall` 命中仍是原文（已记入 ROADMAP，未悄悄宣称已修）。

### 5.2 分数口径必须区分（易错点）

两条路径报的数**不是同一个量**，混着比会得出错误结论：

| 路径 | 报的数 | 是否含 importance 加权 |
|---|---|---|
| `sourceMonitor(claim)`（= `memory_verify`） | 单条最佳 1-NN 的**原始余弦** | 否 |
| `recall().hits[].score` | `similarity × (0.6 + 0.4·importance)`（+ 标识符加成） | 是 |
| `recall().hits[].similarity` | **原始余弦** | 否（与第一行同口径） |
| `recall().hits[].relativeScore` | `similarity ÷ 本次最高 similarity` | 否（本次查询内相对量） |

因此 `sourceMonitor` **不是**"更强的召回入口"：它只取单条最佳（外加邻域证据）、不做重要性加权、也不返回候选列表。它是断言前的是非裁决，不是检索器。

### 5.3 这道门本身是否在起作用（0.3.0）

读出问题有两个层次：库里有什么，以及**这个读通道是否正常**。`diagnostics()` 现在同时回答后者：

| 字段 | 读数 | 为什么放在诊断里 |
|---|---|---|
| `coverage.turns / misses / guesses` | 本进程渲染了几次 digest、其中几次零命中、几次端出了猜测 | 一道永远沉默的门和一道不存在的门看起来一样。`misses/turns` 高 = 问法或门槛有问题；`guesses ≈ misses` = 端出来的多半是猜的 |
| `sibling_stores.stores[]` | 同目录每个 `.db` 的 `rows` / `demoted` / `lastWrite` / `current` | 宿主按 agent / 项目分库，于是"没记住"与"记在隔壁文件"输出同形。只有一个是记忆问题 |
| `suspicious.emptyWhileSiblingsFull` | 本库 0 行而邻居有货 | 上面那条的布尔摘要，两家 `status` 的 `health` 拿它做第一判据 |
| `scope_rule` | 分库契约文本（引擎一处） | 契约文案不该在两个适配层各写一遍 |

`coverage` **刻意只在内存里**：落库的计数器下次启动会被读成"这个库的历史统计"，而它回答的只是"当前这个进程的这道门是否在起作用"。`sibling_stores` 由导出的 `surveyStores(dir, { current })` 提供（`:memory:` 不扫目录，否则会把进程启动目录当成库清单报出去）；打不开的文件进 `unreadable[]`，而不是让整份诊断消失。

---

## 6. 离线过程：consolidate() / forget() / compress() / mergeDuplicates()

```
consolidate(定期 / 会话结束调用)
  对每个"高频情景"（accessCount ≥ 3 或 importance ≥ 0.6）：
    提取语义规则 → 若不存在等价 semantic 则新建
    （跨类型合并会剥离 "FACT: " 前缀，避免 episode / 规则孪生）
  效果：会话后，高频情景被压成少数几条语义规则
  （多重痕迹立场：episode 保留，仍可回答"何时 / 何地"）

forget(定期调用)
  强度 = importance × (0.5 + 0.5·min(1, access/5))
  强度 < floor：
    闲置超阈值 → 软删除（superseded=1，历史保留）——"遗忘但不毁灭"
    未超阈值   → importance × 0.9 衰减（Ebbinghaus）
  dryRun 可预览。折叠行（demoted）永不删除。

compress(计划式，人工把关)
  proposeCompressions() → 同域 episode 分组 + 代表建议（只读）
  调用方起草 invariant → compress({invariant, members, representatives})
  引擎校验（成员存在 / 活着 / 非退休、代表 ⊆ 成员）后落库：
    非代表成员 demoted=1（默认召回排除，includeDemoted 展开）
  undemote(ids) 可恢复；invariant 行带 tag:invariant 且 detail 具名全部成员 id。

mergeDuplicates({ ids, into?, dryRun? })（0.3.0）
  输入只吃**一个** duplicates 组的 id（≥2）。四条拒绝先于任何写入：
    id 少于 2 / 行不存在或已 superseded → 抛错
    行带 retraction / guard / invariant 标记 → 抛错（它们本身就是浓缩结果）
    ids 的 summary 归一化后不是同一句 → 抛错"not restatements of one claim"
      （否则一次"清理"就能借机删掉一条无关记忆）
  幸存行 = into（必须是 ids 之一），否则按价值排序取首个：
    有通过的证据 > access_count > importance > version > 最早 created_at
    ——可重跑的验证结果排在裸重述之前，合并永远不该把唯一能复核的那条并掉
  前提门（与 4.4 同一判据 scopeDifferences）：与幸存行前提冲突的行进 blocked[]
    并点名冲突的 key，其余照常折叠；全都冲突 → survivor 返回 null、一条不动
  先结转再退役（顺序写在注释里：中途崩溃只会留下"没并完"，不会留下"信息丢了"）：
    被并行的实体、标签、更长的 detail、更高 importance 并入幸存行 → carried[] 明说
    db.setDemoted(多余行 → 幸存行)：留在库里、默认召回不再出现、
    list() 一直列出它们（行上 demoted:true）、undemote 随时恢复
  dryRun 默认（适配层预览，dry_run:false 才落地）。
  与 compress 的分工：compress 是"多 episode → 一条 invariant"的**跨抽象层**压缩，
  需要人给文稿；mergeDuplicates 是"同一句话的 N 个副本 → 1 行"**同层**清理，
  不需要写任何新文本。两者共用 demote / undemote 机制。
```

---

## 7. 反幻觉保障：为什么这样能压住"记忆性幻觉"

幻觉分三类，本插件针对第一类：

| 幻觉类型 | 成因 | 插件措施 |
|---|---|---|
| **记忆性幻觉**（本插件解决） | 历史事实被遗忘 / 混淆 / 陈旧 / 编造 | 结构化写入 + 版本化 + 来源标记 + 证据等级 + 三值裁决 + 前提门 + 低置信标注 + 拒绝回答 |
| 参数性幻觉 | 模型训练知识本身错误 | 无法由记忆层解决（需要工具 / RAG / 知识图谱） |
| 解码性幻觉 | 采样随机性 | 无法彻底解决，可降温度 / 约束解码 |

诚实边界：插件不提升模型"懂得更多"，它保证的是——

1. **凡断言必有据**（来源、版本、时间、证据可追溯）；
2. **查无实据则明说**（UNSUBSTANTIATED → 显式拒答，而不是脑补）；
3. **新旧冲突浮出水面**（recall 冲突警告 + verify 邻域证据 + 显式纠正边），而不是让模型二选一靠猜；
4. **前提不核对就不套结论**（支持行属于别的前提 → `OUT_OF_SCOPE`；提问没带前提而支持行带 → `CONDITIONAL SCOPE` 注记），而不是把旧口径下的数字当成新口径的事实。
5. **没过门槛的东西不借用过了门槛的身份**（0.3.0）：零命中时 digest 可以端出最接近的那一条，但它拿不到 `[VERIFIED]` / `[ASSERTED]`，行内自标 `sim 0.31 < floor 0.32 … not a memory`，`items[0].lowConfidence` 让程序侧也能判。旧行为里"库里没东西"与"最像的只打了 0.31"输出同一句话，而后者才是值得看的信号；同时 `coverage.turns / misses / guesses` 让这个取舍本身可读数（见 [5.3](#53-这道门本身是否在起作用030)）。**没有**用近况回填来填空（那会让通道看起来健康）。

神经科学上这也说得通：真正的记忆系统不会"记得一切"，海马负责快速编码与情境绑定，新皮层负责慢慢抽出规律，前额叶负责"我记得吗"的判别。把这三件事塞进一个线性上下文里，模型只能同时当编码器、存储器和判别器——而**判别器缺位**恰恰是幻觉率上升的直接原因。本插件的设计重点不是"记住更多"，而是给模型补上缺失的**判别回路**：`sourceMonitor` + 证据等级 + 邻域可见性 + 前提门。

---

## 8. 集成指南（伪代码）

```ts
import { HippoMemory } from 'hippo-memory-core';

const mem = new HippoMemory({ dbPath: './agent-memory.db' });

// ① 每个回合后：把发生的事写进去（由 agent 或 runtime 生成结构化 payload）
await mem.remember({
  kind: 'episode',
  summary: '用户确认使用 MySQL 作为 billing 数据库',
  entities: [{ name: 'billing' }],
  source: 'user', confidence: 'high'
});

// ② 每个回合前：用当前目标取出要注入 prompt 的记忆片段
const { context } = await mem.composeContext(currentGoal, { limit: 6 });

// ③ 回答前：凡涉及记忆事实的断言先过一遍源监控
const verdict = await mem.sourceMonitor('billing 使用 MySQL');
if (!verdict.substantiated) {
  // 返回"我记不起 / 不确定"，而不是编一个
}

// ③b 只在特定条件下成立的结论：写入和核查都把前提一起带上
await mem.remember({
  kind: 'semantic',
  summary: '替换率 -> 低于独立性基线',
  scope: 'population=all records; comparator=instruction start',
  source: 'tool', confidence: 'high'
});
// 库里那条属于别的前提时 out_of_scope=true（既不赞成也不反对），而不是被盖章支持
const scoped = await mem.sourceMonitor('替换率 -> 低于独立性基线', { scope: 'population=all records' });
if (scoped.out_of_scope) {
  // 在痕迹自己的前提下重问，或把新口径的结论带自己的 scope 另记一条
}

// ④ 会话结束 / 定时：巩固 + 遗忘（先预览）
await mem.consolidate();
mem.forget({ dryRun: true });

// ④b 重复太多影响可读性：先报告，再合并（预览是默认）
const rep = mem.duplicates();                     // 只读；每组带 mixedPremises
const g = rep.groups.find((x) => !x.mixedPremises);
const preview = await mem.mergeDuplicates({ ids: g.memories.map((m) => m.id) });
// preview: { survivor, retired[], carried[], blocked[], dryRun: true, note }
const applied = await mem.mergeDuplicates({ ids: g.memories.map((m) => m.id), dryRun: false });
// 多余行只是 demoted，仍在库里：list() 一直列出它们（行上 demoted:true），
// 默认召回排除，recall(…, { includeDemoted: true }) 才展开
await mem.undemote([applied.retired[0].id]);      // 反悔随时恢复

// ④c "没记住"与"记在隔壁文件"输出同形，所以先看诊断
const d = mem.diagnostics();
// d.sibling_stores.stores[]  同目录每个库文件的 rows / demoted / lastWrite / current
// d.suspicious.emptyWhileSiblingsFull  本库空而邻居满 → 是路径问题，不是记忆问题
// d.coverage                这道门槛本进程开合了几次、几次什么都没放行
```

在 DSH 里这些调用被适配层包装成 4 个工具 + 每轮自动 digest + 使用纪律段落（见 `packages/dsh-hippo-memory/lib/index.js`）。

---

## 9. 已知局限与路线图

- **嵌入质量**：默认的 feature-hash bag-of-words 是同义词弱的粗略相似度。生产环境应 `setEmbedder()` 接入真实嵌入模型（Transformers.js / 本地 ONNX），或开启插件的 `embedding: auto`；接口已预留，不影响其他逻辑。
- **语义规则提取**：`consolidate()` 现在接受 `summarizer` 回调（构造参数或 `setSummarizer()`）做真正的 LLM 抽象，抛错/返回空回退到模板路径；默认无钩子时仍是 `FACT:` 模板（诚实标注为占位实现）。
- **否定与反事实**：`sourceMonitor` 用否定词启发式判断矛盾（含中文否定词），对"并非所有 X 都是 Y"这类量词否定会误判——需要真实语义模型。
- **scope 判定（前提作用域已落地；读取硬过滤已落地；命名空间仍未做）**：行上的 `scope` 已把"在什么条件下成立"变成契约——写入前提门、`sourceMonitor` 的 `OUT_OF_SCOPE` 与 `[scope: …]` 渲染都走它（见 [4.4](#44-前提门换口径的重测不是同一句话)）。**读取侧**：`recall(cue, { scope })` 可硬过滤前提冲突的行（计数 `scopeExcluded` + 警告，未声明前提的行通过）——这是通往命名空间的收敛步，不是终点。**尚未做**的是把它当项目 / 仓库 / 会话组的**命名空间**用：库级隔离仍由 `sharedStore` + 每会话一个文件承担。另外它不认 key 改名与整段换语言的同一前提（`pop` vs `population`）。
- **多 agent / 共享记忆**：`sharedStore: true` 下多个 agent 共用一个库（WAL + busy_timeout 已解决并发写），但**跨机器同步与冲突合并尚未实现**。
- **库分裂：能诊断，不能打通（0.3.0）**：`sibling_stores` / `scope_rule` / `emptyWhileSiblingsFull` 让"记在隔壁文件"不再长得像"没记住"（见 [5.3](#53-这道门本身是否在起作用030)），但记忆**仍然不跨库文件流动**，也没有"把隔壁那个库并进来"的动作。这是刻意的：自动合并两个宿主维度（DSH 的 agent id × opencode 的项目目录）等于替用户决定作用域，而误并比空库难查得多。
- **重复判定只认逐字重述（0.3.0）**：`duplicates()` 按归一化文本相等分组（剥 `FACT: `、忽略大小写与标点），所以换了说法的重述不会出现在报告里。`mergeDuplicates` 也因此**不引入新的相似度阈值**——它只接受"同一组里点名的 id"，把是否近似的判断留给调用方。宁可漏并，不可错并：错并会把两条不同断言变成一条。
- **折叠行的可见性在两家里不等**：被 merge / compress 折叠的行由 `list()` 一律列出（带 `demoted: true`），但**从召回侧展开**只有引擎 `recall(..., { includeDemoted: true })` 与 DSH 的 `include_demoted` 参数；opencode 的 `memory_recall` 目前没有这个参数，要找回折叠行只能用 `memory_maintain { action: "list" }` 读 id 再 `undemote`。
- **情感 / 情绪标签**：人脑记忆强度受杏仁核调制；本插件用 `importance`（可显式声明）近似，暂未实现情绪维度。
- **召回策略的取舍**：当前以"诚实性 > 召回率"为原则：宁可拒答（refuse）也不编造（confabulate）。③ 之后这条有了边界：门槛**本身没动**（`recall` 的 hits 仍然一个都不放），只是零命中的 digest 不再假装库里没有别的东西可看——端出来的那一行带 `low-confidence` 身份，因此"宁可拒答"约束的是**裁决**，不是**可见性**。

### 0.2.0 补记：纠正链的数据模型

反幻觉评审指出的"裁决只看 argmax"在本版做了三处补强：

1. **证据不只有 argmax**：`sourceMonitor` 的交付物从"一行 + closest"变为"一行 + 邻域扫描"（`contradicting[]` / `newer_related[]` / `superseded_matches[]` + `stale_support`）。裁决仍由 argmax 定调，但**邻域证据同时交给调用方**——前额叶"核对一下我记得的整版"在工程上对应的是"同 scope 的行都拿出来看"，而不是"只信最像的那一条"。
2. **显式纠正边**：`memories.superseded_by` 列。与 `override`（同 id 版本链）互补：override 是系统自判的更正（余弦 + 实体匹配），`supersedes` 是**写入方声明**（"我验证过，就是这条错了"）。两者都保留旧行（审计），但 supersedes 产生新 id、旧行整体退出召回。神经科学类比：再巩固（reconsolidation）既有自动重写，也有定向重评。
3. **可观测性**：`diagnostics()` 把"系统是否在正常工作"从猜测变成读数：存量向量维度直方图能捕捉静默的 embedder 回退——这是垃圾余弦 → 永久零命中的唯一可测环节。
