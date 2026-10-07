# 🧠 HippoMemory —— 给 DSH Agent 装上"海马体"

> 一句话：**让 DeepSeek Runtime 的 agent 拥有跨会话、跨重启的长期记忆，长会话不再忘事、不再幻觉。**
> 当前版本：引擎 `hippo-memory-core` 0.3.3 ｜ DSH 插件 `dsh-hippo-memory` 0.3.3（**需宿主 DSH ≥ 0.1.7**）｜ opencode 插件 `opencode-hippo-memory` **0.4.0**（批次 2026-10-07：插件面从 V1 移植到 **V2**，**破坏性**——只认 opencode 2.x；三枚号从这一批起不再齐步走，引擎与 DSH 的字节一字未动所以停在 0.3.3；上一发布线为 0.3.0 / DSH 0.3.1）

## 为什么你需要它？

用过 DSH / 任何 agent 的人都遇到过：

- 会话一长，**早期结论被上下文挤没** → agent 开始忘事；
- 换了新会话，**前面查清的事实、定下的规矩全部归零**；
- 被追问细节时，**没有依据就开始编**（幻觉）。

**HippoMemory 模仿人脑海马体**，给 agent 装了一个本地长期记忆库：重要结论**主动存**（write），需要时**按线索想起来**（recall），开口前**先核对依据**（verify），记忆还会**自动整理**（consolidate / forget）。

> 关于效果数字：仓库自带的 `bench/anti-hallucination-bench.mjs` 是**检索臂模拟**（答题端用字符串匹配模拟器，不是真实 LLM），样本只有 8 问。它的价值在于对照结构，不在绝对数字：同一长会话脚本下，**有界窗口臂** 0/8 答对、**朴素全文 RAG 臂**编造率 63%（自信地端出被更正前的旧值）、**HippoMemory 臂** 6/8、编造率 25%。RAG 对照说明的正是本插件的核心差异——**没有版本化纠正链的向量检索会自信地召回过期事实**。真实 LLM 端到端的幻觉率测量仍待补（见 ROADMAP）。

## 安装（30 秒）

```bash
dsh plugin --profile web add dsh-hippo-memory
dsh web
```

重启后：**插件 → dsh-hippo-memory → hippo-memory 行**，默认已启用。

## 它给你的 agent 加了什么？

| 能力 | 效果 |
|---|---|
| 🛠 4 个记忆工具 | `memory_remember` / `memory_recall` / `memory_verify` / `memory_maintain`，agent 自主调用 |
| ⚡ 每轮自动回忆 | 开工前自动注入与当前任务相关的旧结论（`[hippo-memory digest]`），**命中才耗 token**（约 20–40 tok/条） |
| 📏 记忆纪律 | 系统提示教 agent：何时该记、该查、该验证（WRITE → RECALL → VERIFY → MAINTAIN） |
| 🎛 GUI 设置页 | 一键开关、注入条数、共享存储（跨会话协作 / 隔离）、嵌入模型、召回阈值 |
| 🔒 纯本地 | SQLite 存储（`~/.dsh/storages/hippo-memory/`），**零外部服务、零网络请求**，数据自己掌控 |
| ♻️ 纠错链 | 用户纠正时旧记忆自动版本化存档，永不覆盖丢历史；也可用 `supersedes` 显式点名退役错误条目 |
| 🔍 召回可解释 | 每个命中给三个分数（原始余弦 / 排序分 / 本次相对分）加一个**依据标签** `anchored`／`anchors`（这一行凭什么在这里：标识符 / 实体 / 主体 / 词表；没有 cue 时明写 `recency`，即"因为最近写过"）；**只有向量距离、词法上对不上 cue 的命中 `anchored: false`**——排序照旧有效，但它不是证据；**查不到时说明原因**并列出最接近的几条 |
| 🧩 前提作用域 | 结论可带 `scope`（`population=… ; comparator=…`，**裸词同样算前提**）声明"在什么条件下成立"；换口径的重测**各存各的不覆盖**，`memory_verify` 会答 `OUT_OF_SCOPE` 而不是把旧口径的答案盖到新问题上。0.3.2 起**前提冲突的行即使没抢到支持位也能否决裁决**（列在 `scope_conflicts[]`，两条并列路线：分数不低于所选支持，或与问句说的是同一件事——只有实体相同不算），且写在**你没点名的那条轴**上的前提被读成"没法比"（G1），**第九批（G3）让"不背书"这三个字真正落地**：抢到支持位的行如果自己就写在调用方没点名的轴上，它不再被盖章成 `substantiated`，同样转 `OUT_OF_SCOPE`（两侧各自的轴印在 note 里，`scope_conflicts[]` 保持空表）。**第十一批再补两格**：RR1 把"不静默改变通说的覆盖面"接到写入侧漏掉的第四道门——同一句通说被"换个值 + 加个前提"的写法覆盖过去，现在两条并存、回 `premise-narrowing:`；RR2 把"没写前提"从无条件优先改成有条件——一条讲的是另一件事的通说行，不再从支持位上挤掉**逐字复述你那句话**的那条（空真可比 ≠ 高相关）|
| 🚫 同话题 ≠ 记住（也不等于反证） | 0.3.2：`memory_verify` 的**两条出口都要锚**。yes 一侧：同主体且值不冲突 / 共同标识符（工单号、sha、版本号）/ 痕迹逐字或几乎逐字带着这句话 / 余弦过主张线 0.75；只有"话题相邻"时返回 `weak_match`，note 里印出两个余弦，模型拿到的仍是"不知道"，而不是一个盖了章的幻觉。**锚命中了还要过三道 belt**（极性相反 / 两边点名的标识符不同 / **两句话只差一个词，而那个位置是值或是主语**），任一成立就降成 `weak_match`。contradicted 一侧同一把尺：值被绑成另一个（**含中文 `X 是 Y` 的问法**，装机复测 R1 前这类错误值会被盖章成 yes）或同主体极性翻转才算反证；"旁边有条含否定字的行"不再定案，只在 note 里点名（R2）。最后一道 belt 读的是**位置**而不是词表：把 `production` 换成一个根本不存在的词 `zzzqqq`，结果一样（第五轮普查的那条控制）。它原先还要求"分歧离句首够远"，量的其实是一个句子的**哪一位**在动：主语换位（`the primary …` 问成 `the standby …`）同样不算证据，而两侧把同一个数说出来时（`设定为 30 秒` 问成 `最多 30 秒`）措辞差异不算值冲突（第六轮）。 |
| ✅ 证据与前瞻 | 需要复跑的结论可带 `verify_cmd`（渲染标 `[VERIFIED]`）；"以后遇到 X 要先做 Y"可注册为 `[GUARD]` |
| 🧹 重复与审计 | `duplicates` 只读列出重复重述，**两条通道**（每组带 `by`）：`text` 是换个壳/大小写/空格的同一句话，`vector` 是 0.3.2 起的**换措辞说同一件事**（余弦 ≥ `nearDuplicateThreshold`，默认 0.92；组里 `similarity` 给出最弱那条边，`text` 组为 `null` 因为它不主张分数）；两组都带 `mixedPremises`：两种前提下的同一句话不是重复。`merge` 把确认过的一组**折叠**成一条，多余行仍在库里、`undemote` 可恢复，不必用会连历史一起删的 `delete`；`override-audit` 筛出可疑覆盖。先看再动，不会自动改你的数据 |
| 🚪 空结果不再同形 | 召回全部低于门槛时端出最接近的那条并标明 `[low-confidence … not a memory]`；`status` 看得见同目录隔壁的库文件，"没记住"与"记在另一个文件"从此不是一句话 |
| 🛡 防投毒 | 记忆里混入 ignore-all-previous-instructions 类劫持文本时，渲染出口统一清洗 + 数据框架隔离，可疑行点名待审 |
| ⏳ 间隔重复 | 复述 / 召回按"距上次访问的间隔"对数加权强化（集中重复几乎无增益）；`importance` 可显式声明 |

## 典型用法

**场景一：长线攻坚**（几百轮不停）
> 让 agent 每轮收尾自检"这轮有值得长期保留的结论吗"，有就 `memory_remember` → 上下文再长也不怕忘。

**场景二：多会话项目协作**
> 开共享存储，A 会话查清的结论 B 会话直接想起来——不用重新交代背景。

**场景三：压低编造率**
> 告诉 agent："引用旧事实前先用 `memory_verify` 核对，查无实据就明说，不要编。"编造率肉眼可见下降。0.3.2 起这句话有引擎兜底：**话题相近不再算"记住"**——没有锚的匹配返回 `weak_match`，模型拿到的仍是"不知道"。

## 0.2.1 —— 引擎支持 Bun（npm 当前 0.3.3，本节只讲这一枚能力是怎么来的）

> `hippo-memory-core` 现在**运行时探测** SQLite 驱动：Node 用 `node:sqlite`、Bun 用 `bun:sqlite`。这意味着**引擎可以直接跑在 opencode 里**（实测 opencode 1.18.31 / Bun 1.3.14，无需打包无需垫片；那一版宿主是 V1 面）。
> ✅ opencode 用户装配套插件即可：`opencode plugin add opencode-hippo-memory`（V2 命令面；旧的 `-g` 写法属于 V1，照抄会失败）——同样是 4 个工具 + 每轮注入 + 压缩保留 + 纪律。**注意**：V2 面从 **0.4.0** 起，0.3.3 及更早那几枚在 opencode 2.x 上什么都不会加载；而 **0.4.0 至今没有一台活的 V2 宿主加载过**（34 枚用例走的是假宿主），见该包 README 的安装一节。

## 0.2.0 新东西（一句话版）

- **纠正链**：verify 返回四组邻域证据（反极性行 / 更新的结论 / 被退役的行 / 支持已过期），remember 回显最近邻并支持显式 `supersedes`；
- **抗幻觉四件套**：证据（带 30 天保鲜期）、撤回、前瞻守卫、值域先验；
- **覆盖判定加双口径门**：长 detail 不再把无关记忆误判成同一主张——宁可多存一行，也不丢数据；
- **投毒防护 + 深度健康诊断（`status` → `health`）+ 间隔重复 + 并发写安全**。

完整说明见 [CHANGELOG.md](../CHANGELOG.md) 与 [README 的 0.2.0 一节](../README.md)。

## 链接

| 包 | npm | 说明 |
|---|---|---|
| `dsh-hippo-memory` | https://www.npmjs.com/package/dsh-hippo-memory | DSH 插件（你要装的就是这个） |
| `hippo-memory-core` | https://www.npmjs.com/package/hippo-memory-core | 引擎，框架无关（可单独用于其它 agent 框架） |
| 源码 | https://github.com/guoxing2024/hippo-memory | 欢迎 star / issue |

## 完整文档

| 想了解 | 看这个 |
|---|---|
| 逐项设置、对话模板、十四种场景话术、21 条 FAQ | [docs/USER-GUIDE.zh-CN.md](USER-GUIDE.zh-CN.md) |
| 数据结构、写入 / 读取路径、神经科学映射 | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| 引擎 API、评测基准、召回质量细节 | [README.md](../README.md) |
| 待办与计划 | [ROADMAP.md](../ROADMAP.md) |

---
*MIT License · 用 ❤️ 和 SQLite 写成*
