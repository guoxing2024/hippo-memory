# 🧠 dsh-hippo-memory

**海马体式长期记忆插件（DSH）** —— 让 DeepSeek Runtime 的 agent 拥有跨会话、跨重启、抗遗忘的长期记忆。

```
没有它：   长会话 → 上下文爆掉 → 旧事实被挤没 → 幻觉 / 自相矛盾
有本插件： 重要结论自动沉淀 → 每轮按需唤起 → 断言前先查证 → 不再凭空编造
```

> 引擎（框架无关）是独立包 [`hippo-memory-core`](https://www.npmjs.com/package/hippo-memory-core)；本包是 DSH 适配层：工具 + 自动注入 + 使用纪律 + GUI 设置页。
> ⚠️ 本包是 **DSH 专属**适配层，**不能在 opencode 等其它宿主里安装**。引擎 `hippo-memory-core` 自 0.2.1 起可在 Bun 上运行（opencode 用 Bun）；面向 opencode 的适配包 `opencode-hippo-memory` 已发布（同在本仓库 `packages/` 下）。
> ⚠️ 配置面（GUI 那一页）要求宿主 **DSH ≥ 0.1.7**：0.1.7 起插件导出 volatile `Config`、浏览器半侧走 `ctx.configForms` 注册到插件页的 `plugins.row.config`，旧的 `settings.register()` / `settingsScope` / `settings.plugin.item` 已全部删除。四个记忆工具本身不依赖配置面。
>
> 当前版本：**0.3.2**（**已发布 npm 2026-10-06**；需要引擎 `hippo-memory-core@^0.3.2`——本版转发了引擎对 `memory_verify` 的契约订正：**两条出口都要锚**，只有"有锚"的匹配才算支持、也只有"有锚"的反证才算矛盾（含中文的值冲突），前提冲突的行即使没抢到支持位也能否决。上一发布线：本包 0.3.1 / 引擎与 opencode 0.3.0）。**宿主不到 DSH 0.1.7 请停在 0.3.0**（`dsh plugin --profile web add dsh-hippo-memory@0.3.0`）。详细使用说明见 [完整中文使用说明](https://github.com/guoxing2024/hippo-memory/blob/master/docs/USER-GUIDE.zh-CN.md)。

---

## ✨ 它给 agent 加了什么

| 能力 | 说明 | 何时触发 |
|---|---|---|
| **4 个记忆工具** | `memory_remember` 写 / `memory_recall` 查 / `memory_verify` 校验 / `memory_maintain` 维护（13 个动作） | agent 自主判断（有使用纪律引导） |
| **每轮自动回忆** | 用你这一轮的话当线索，把相关旧结论注入一条 `[hippo-memory digest]` 块；**命中才耗 token**（约 20–40 tok/条）。全部低于门槛时不再空白：最接近的那条会以 `[low-confidence …]` 端出并标明"这不是记忆"（0.3.0） | 每轮开工前自动 |
| **记忆纪律** | 系统提示教 agent：何时记、何时查、何时验（WRITE → RECALL → VERIFY → MAINTAIN） | 插件启用即注入 |
| **纠正链** | `memory_verify` 返回 `contradicting[]` / `newer_related[]` / `superseded_matches[]` / `stale_support`；`memory_remember` 回显 `neighbours[]` 并接受 `supersedes` | 0.2.0 起 |
| **前提作用域** | `memory_remember` / `memory_verify` / `memory_recall` 都接受 `scope`（`key=value; …`）：写入声明结论成立的条件、verify 返回 `out_of_scope`、recall 按前提**硬过滤**冲突行并回 `scopeExcluded`——换口径的重测不再被当成同一句话 | 写入 / 查证 / 召回时可选（0.3.0） |
| **两条出口都要锚** | `memory_verify` 的 `substantiated` 不再只看"有没有痕迹越过召回线"：必须有锚（同主体不冲突 / 共同标识符 / 逐字复述 / 特征词覆盖 / claim-to-summary ≥ 0.75），否则给 `weak_match: true`。**同一把尺也量 `contradicted`**：值被绑成另一个（含中文 `X 是 Y` 的问法）或同主体极性翻转才算反证，"邻近某条含否定字"不再定案。前提冲突的行**即使没抢到支持位**也能否决，落选者点名在 `scope_conflicts[]` | 每次 `memory_verify`（0.3.2） |
| **重复合并** | `memory_maintain { action: "duplicates" }` 只读报告重复，**两条通道**（每组带 `by`）：`text` 同一句话换个壳、`vector`（0.3.2）换措辞说同一件事（余弦 ≥ `nearDuplicateThreshold`，默认 0.92）；两组都带 `mixedPremises`，确认后 `{ action: "merge", ids: [...] }` 折叠成一条；多余行不删、`undemote` 可恢复 | 长会话整理时（0.3.0，向量通道 0.3.2） |
| **证据与前瞻** | `verify_cmd` / `verify_expect` / `verify_artifact` + 保鲜期；`retracts` 撤回；`guard_trigger` / `guard_action` 前瞻守卫 | 写入时可选 |
| **防投毒护栏** | 渲染出口统一清洗指令劫持文本为 `[sanitized-*]`，digest 整体包 `[memory data]` 数据框架；**存储原文不动**，可疑行由 `injection:` 警告点名 | 引擎自动 |
| **可观测性** | `status` 返回一句话 `health` + 深度诊断（嵌入器类型/维度、向量维度直方图、`dimMismatch`、阈值、访问统计）。0.3.0 新增：`path_rule`（本 agent 的库文件名是怎么来的）、`sibling_stores`（同目录每个 `.db` 各有多少行）、`coverage`（本进程召回门槛开合了几次、几次什么都没放行）；`health` 第一判据改成"本库空、隔壁满" | 怀疑召回坏了时 |
| **间隔重复** | 复述 / 召回按距上次访问的间隔对数加权强化；`importance` 可显式声明 | 引擎自动 |
| **GUI 设置页** | 插件 → dsh-hippo-memory → hippo-memory 行 | 随时开关、调参 |

---

## 📦 安装 / 升级

```bash
# 安装在 web profile（图形界面那个）
dsh plugin --profile web add dsh-hippo-memory

# 升级到 0.2.0
dsh plugin --profile web update dsh-hippo-memory

# 重启该 profile 生效（必须完整退出，不是刷新页面）
dsh web
```

装完打开 **插件 → dsh-hippo-memory → hippo-memory 行**，应能看到它的配置页（默认启用）。

> 其它 profile 把 `web` 换成对应名字（如 `headless`）。升级 0.2.0 是**数据零迁移**：旧记忆库照常读取，新字段只对新写入生效。

---

## ⚙️ 设置项（GUI 卡片里调整）

| 字段 | 默认 | 含义 |
|---|---|---|
| **启用** | 开 | 关掉 = 卸载全部记忆工具 / 纪律 / 自动注入（**记忆数据保留**，再开即恢复） |
| **上下文条数上限** | 6 | 每轮自动注入的记忆摘要条数上限（1–20，越大越耗 token） |
| **共享存储** | 关 | 开 = 该 profile 内所有会话共用一个记忆库；关 = 每会话独立库 |
| **嵌入模型** | off | `off` = 内置快速哈希嵌入；`auto` = 懒加载本地 bge-small-zh-v1.5（量化约 24MB，缓存于 `storages/hippo-memory/models`），中文 / 同义表达召回显著增强；加载失败自动回退哈希 |
| **召回阈值** | 留空 | 召回 / 验证相似度下限（0.05–0.95）。留空用引擎默认 0.32。调低 = 更宽松召回，调高 = 更严格 |

> ⚠️ **共享存储**建议想清楚再开：开共享后 A 会话写的事实 B 会话能查到（协作），但也会互相串味。单项目多会话协作开它，多项目混跑保持关闭。

---

## 🧠 怎么让 agent 真正用起来

插件**默认启用即生效**，但工具调用是模型自主决定的。想让某个会话认真用记忆，直接把这段话发给它：

```
从现在起：学到的持久结论要调用 memory_remember 存入长期记忆（summary 用 主体 -> 结论 格式）；
被问及旧事实 / 旧决策前先 memory_recall 查记忆库；断言记忆前用 memory_verify 校验；
每轮收尾自检有没有值得长期保留的结论。查无实据就直说，不要编。
```

记忆默认按 **agent id 分库**（DSH 里通常就是每个会话一个 agent id）：

- 库文件在 `~/.dsh/storages/hippo-memory/<agent-id>.db`，实测最常见的是 `session-<id>.db`；开 `sharedStore` 后所有 agent id 合并写 `shared.db`；
- 记忆不会因会话删除 / 上下文清空而丢失；插件关闭再开启，数据仍在；
- **代价**：A 会话记下的东西 B 会话查不到——它们在两个文件里。`memory_maintain { action: "status" }` 的 `path_rule` 说明本 agent 的文件名怎么来的，`sibling_stores` 列出同目录每个 `.db` 各有多少行（0.3.0）。

---

## 🛠 工具速查

### `memory_remember` —— 写入

必填 `kind`（episode 事件 / semantic 规则 / procedure 技能）与 `summary`（一句话）。常用可选：

| 参数 | 用途 |
|---|---|
| `detail` | 原始细节（供深度回顾） |
| `entities` / `tags` | 实体（检索 + 冲突范围）/ 自由标签 |
| `scope` | 这条结论成立的**前提**，`key=value` 用 `; ` 分隔（如 `population=all records; comparator=instruction start`）。**裸词也算前提**（如 `the production cluster`）：0.3.2 起它收进内部键 `@premise` 参与比较，所以裸写与键值写跨形式可比（`eu-west` 对 `region=us-east` 判**冲突**，见 `docs/USER-GUIDE.zh-CN.md:518` 那张表）。前提对不上的两条各存各的，不互相覆盖 |
| `source` / `confidence` | 来源（user / tool / config / agent）与写者可信度 |
| `importance` | 0..1 显式重要度（用户长期偏好 0.9+、项目关键事实 0.8+、一次性观察 <0.4） |
| `verify_cmd` / `verify_expect` / `verify_artifact` / `verify_result` / `verified_at` | 可复算的出处（引擎**不执行命令**，只存档 + 把关渲染） |
| `supersedes` | id 数组：显式退役错误记忆（纠正链） |
| `retracts` | 本写入撤回的 id（配合 `tags: ["retraction"]`） |
| `guard_trigger` + `guard_action` | 前瞻守卫（配合 `tags: ["guard"]`） |

返回：`outcome`（new / none / merge / override / supersede）、`id`、`version`、`scope`、`verify_result` / `verified_at`（复述带上新证据时回显，无证据为 `null`）、`superseded`、`neighbours[]`、`warning`、`scope_only_matches`。

### `memory_recall` —— 检索

`query` 必填；`entities` / `kind` / `limit`（默认 8，上限 20）/ `include_demoted` / `scope` 可选。传 `scope`（`key=value; …`）时按前提**硬过滤**冲突行、返回 `scopeExcluded` 计数并附 `scope:` 警告；命中带 `scope`（该条自己的前提）。每个命中还带 `anchored` / `anchors`（0.3.2）：这一行与 `query` 之间有没有可指认的词法依据、是哪一档（`identifier` / `entity` / `subject` / `vocabulary`；空 cue 或近期回填为 `recency`）。**`anchored: false` 的排序照样有效，但它只是向量邻近，不是证据**（见下表）。

### `memory_verify` —— 断言前查证

`claim` 必填，可选 `scope`（你问的是哪个前提下的这句话）。返回 `substantiated` / `contradicted` / `out_of_scope` / `weak_match` / `closest` / `scope_conflicts[]` + 四组证据（见上表）。**五种结局**：

| 裁决 | 含义 | 能不能当证据 |
|---|---|---|
| **SUBSTANTIATED** | 有痕迹，且**有锚**（见下） | 可以，这是唯一能直接复述的 `substantiated: true` |
| **CONTRADICTED** | 有反证 / 有更新版本，**且同样要有锚**（值被绑成另一个，或同主体极性翻转） | 不能，按 `contradicting[]` 改口 |
| **OUT_OF_SCOPE** | 最接近的那条属于别的前提，记忆既不赞成也不反对 | 不能，换 `scope` 重问 |
| **WEAK_MATCH**（0.3.2） | 有痕迹越过召回线，但**没有锚**——只是话题相近 | 不能。`weak_match: true` 也是 false，不许靠读它的 `support` 升成 yes |
| **UNSUBSTANTIATED** | 没记过 | 不能，回答"我不知道 / 不在我的记忆里" |

**"有锚"指什么**（0.3.2 起，按序命中任一即可）：① 解析出同一主体且值不冲突；② 出现共同标识符（工单号 / sha / 版本号）；③ 痕迹逐字带着这句话；④ 痕迹承载了这句话的特征词；⑤ 都没有才回落到 claim-to-summary 余弦 ≥ `claimThreshold`（0.75）。为什么不能只抬门槛：实测一个幻觉与一句合法改写在哈希空间里余弦**相同（都是 0.444）**，分得开它们的不是这个数，是锚。没锚时 `support` 仍带出（身份是"复查线索"），note 以 `WEAK_MATCH:` 开头并把召回 sim 与 claim-to-summary sim 两个数都印出来。**锚命中了还不算完**：三道 belt 任一道成立就把这个 yes 降成 `WEAK_MATCH`——极性相反（R2）、两边点名的编号不一致（R3 / R4b）、**两句话只差一个词，而那个位置是值或是主语**（V1 加这条，V2 把它的前提从"分歧离句首够远"换成"分歧落在哪一位"）。第三条读的是**位置**，不是词表。

**① 不只认 `主体 -> 值`（装机复测 R1）**：引擎的解析器认 `X -> Y`（与语言无关）和英文系动词（`X is/uses/runs on Y`），中文的 `X 是 Y` 过去解析不出来，于是"值冲突"那道检查整体失效——真值 `gto 最大并发连接数 -> 128`，问 `gto 最大并发连接数是 512` 得 `substantiated: true`（bge 0.81），而写成 `-> 512` 会正常报矛盾。现在 ① 里多了两条兜法（单边解析 + 另一方以该主体开头；两边都不解析时比"逐字前缀之后第一个数"），中文的错误值也会判 **CONTRADICTED**，note 印 `memory binds "<主体>" to "<库里的值>", not "<你问的值>"`（实测 0.89 / 0.83）；真值与合法细化照常 SUBSTANTIATED（0.91 / 0.81）。

**矛盾这一侧同样要锚（装机复测 R2）**：以前只要极性不一致就定矛盾，而中文的否定字单字即算（`不`/`没`/`未`/`非`），于是库里存过一条含"不"的中文记忆，就能"反驳"任何一句英文否定断言（实测 `python is not a compiled language` 0.58 被判 `contradicted: true`，点名的是不相干的那条）。现在这类要有结构证据才定案；**不成立时不判矛盾**，改为在 note 里追加 `NOTE: a nearby trace asserts the OPPOSITE polarity … a coincidence of negation, not a proven conflict.`，痕迹照旧随结果带回（实测这种形状它在 `support` 位上，`contradicting[]` 为空——该数组要求与支持行实体相交）。**对你的处置**：看到这条 NOTE 当"没依据"用，别读成"记忆里有反证"。真正的同主体翻转照常定案（`the gateway runs nginx` vs `does not run nginx`、`支持` vs `不支持`）。

**换了号就不是同一件事（装机复测 R3）**：库里存 `KAPPA-1 record`，问 `KAPPA-2 record` ——以前这两个**不同工单**会被读成"同一主体、值被改了"而判 `contradicted: true`（引擎把标识符尾部的数字当成了值，note 里印的是 `binds "…kappa-" to "1"`）。修好那一半之后它**并没有变安全**：同一对形状改被盖章 `substantiated: true`，bge 下实测最高 0.982（`gto 工单 OPS-417 定下 cache backend` 被问成 `OPS-418`），所以引擎另加了一条护栏——两边各自点名的编号若对不上，靠共有措辞撑住的那枚锚不成立。**现在的结局是 `WEAK_MATCH`**，note 直接点名两边的标识符（`the trace names kappa-1 while this claim names kappa-2`）。**对你的处置**：工单号 / sha / 版本号只有**两边同一个**才算证据，也别把这类 `weak_match` 当成"库里有个相反的版本"。真正的数值翻转照旧判矛盾（`超时设定为 30 秒` vs `…90 秒`）。

**这条护栏认的"编号"比你以为的宽（R4 / R4b / R4c，复测者定性 R4 为 R3 修复引入的回归）**：判据里一枚 label = **以 `- _ . : /` 相连的字母数字串、且含至少一个数字**（唯一例外：整串本身就是 ≥7 位的十六进制时纯字母也算——`deadbeef` 与 `cafebabe` 是两个不同的 commit，这条例外是 R4c 补的）。所以除工单号之外，`2024-05-01`、`2024z`、`2025Q1`、`v1.2.3`、`10.20.30.41`、`us-east1a`、`h7` 都算——**只要两边各有一个对方没有的，就不算同一件事**（`the trace names 10.20.30.41 while this claim names 10.20.30.42`）。两点值得知道：① 光共享前缀不算抵消——`OPS-417` 与 `OPS-418` 长前缀相同照样降级，日期只差年份也一样；② **只有痕迹多说了编号、你的断言没提**时不否决，那是"库里比你想的更细"，仍算支持（R1 定的"细化不是冲突"）。不含数字、又不是 ≥7 位 hex 的词（`long-tailed`，乃至 `commit` 这种裸词）不算编号——这条过滤挡的是**所有普通词**，不只是连字词——**而这条"必须含数字"是承重的**：R4c 是作者自己抓到的，第一版实现加上它时顺手把旧形状表里"`[0-9a-f]{7,40}`"那一支的覆盖废掉了，于是完全没有数字的 sha 不再是 label（`commit deadbeef …` 被问成 `commit cafebabe …` 在该版是 `SUBSTANTIATED`，两枚 sha 明明各有一个对方没有）；单臂减法看不见这一形（旧表本身就收 `deadbeef`），只有多构建差分抓得到。**它留下的边界是词例**（`long-tailed` 对 `short-tailed`、`readwrite` 对 `readonly`，此前在所有构建上都只按余弦判）——这一形**已由下面那条 V1 关掉**，而不是靠拆掉"必须含数字"（拆它会把你自己的合法改写一并降级，实测 bge 空间 7/8 条）。**对你的处置**：想让某句话被记住并能被 `verify` 盖章，就把编号**逐字写进句子**、问的时候也带上；两边编号不一致时的 `WEAK_MATCH` 是"库里那句讲的是另一件事"，不是"库里有一个相反的版本"。

**只差一个词，就不是同一件事（V1，第五轮普查）**：库里 `gto deploys to staging cluster`，问 `gto deploys to production cluster` —— 此前这里给的是 `substantiated: true`（本机复跑：哈希 0.75 / bge 0.87），因为五枚锚里没有一枚读"值"这一位。报告者做的那条控制实验是决定性的：把 `production` 换成一个**根本不存在的词** `zzzqqq`，照样盖章（0.77 / 0.83）。所以缺的不是一张"staging / production 这类环境名"的词表——补词表碰不到这一形。现在第三条 belt 读**位置**：两段文本词数相同、只在一个位置上不同、该位置之前有共同的上下文，而那个位置两侧都是能承载值的词（中文两个汉字就算，拉丁要四个字母），就把这个 yes 降成 `WEAK_MATCH`，note 点名两个值（`the trace binds this subject to "staging" where this claim binds it to "production" — the wording matches up to that one word, so what it shares is the shape of the sentence, not the value`）。**它给的是 `WEAK_MATCH` 而不是 `CONTRADICTED`**：一个谓词可以对多个值同时为真（`deploy to staging` 与 `deploy to production` 可以并存）；写成 `主体 -> 值` 或系动词句式时照旧走反证，那条路一行没动。**只对了一半，第六轮补上另一半（V2）**：这条 belt 当时还要求"分歧之前有 ≥4 个实字符的共同上下文"，而它量的是**分歧离句首多远**，不是**哪一位动了**。同一个数因此在两侧各错一次——`the primary handles writes` 问 `the standby handles writes` 前面只剩冠词，于是盖章 yes（bge 0.831），而语义相同、前面多一个真词的 `gto the standby handles writes` 在**更高**的余弦上被否掉（本机 0.876 / 报告者 0.871）：**没有哪个阈值能同时修两侧**，所以换的是判据。现在剥掉分歧前的连接词与冠词，什么都不剩就说明动的是**主语**（`nginx proxies requests` 对 `haproxy …`），与值位一样只降级，且**两条 note 各说各的理由**：值位说 `the trace binds this subject to "staging" where this claim binds it to "production"`，主语位说 `what this claim puts first — "standby" — the trace puts first "primary", and nothing but connectives stands before that slot …`（后者不会假装存在一个共同主体）。另一侧同时补上：两侧在分歧处**陈述同一个数**时不降级——`probe gateway timeout configured 30 seconds` 问 `… capped 30 seconds` 回到 `SUBSTANTIATED`（sim 0.79），中文的 `probe 网关超时设定为 30 秒` 问 `… 最多 30 秒` 回到 yes（bge 0.94），这正是本轮放宽要救的那四形。**换数字仍然判反证**（`… configured 90 seconds` → `CONTRADICTED`）。这条豁免的窗口是 12 个非数字字符、从被换掉的词自己起算且两侧都要够到数，所以 `… configured at 30 …` 问 `… capped at 30 …` 仍在降级一侧（已知过阻）。**对你的处置**：这类 `WEAK_MATCH` 同样是"没依据"，别读它的 support 反推 yes；想让一句被盖章，就把值写成库里那一行的原样（带 `->` 或同一个系动词），或者让两侧把同一个数说出来。已量的边界：不带空格的中文（`超时30秒` 那一形要靠 R5 那条数值路）、以及一次改两个词的改写仍只剩余弦那一枚锚。

**前提否决范围**（0.3.2）：与调用方 `scope` 冲突的行**都有否决权**，即使它没抢到 support 位（此前那段比较只看抢到支持行的 `scope`，而排序刻意把无前提行排在冲突行之上，等于不可达）。够得着否决有**两条并列路线**：匹配度不低于所选支持，**或**它与你的问句说的是同一件事（`recallAnchors` 的 `identifier` / `subject` 两档；**只有实体相同不算**——库里记过同一个服务的两件事，`api` 这个 token 就在所有行里共享，那是话题不是断言）。`scope_conflicts[]` 点名落选的否决者——**支持行自己就冲突时该清单为空**，那条的 id 印在 note 里。另一条边界同一批订正：写在**你没点名的那条轴**上的前提（你问 `region`、它写 `release=v2`）**既不是冲突也不是同意，是没法比**，它不再抢到支持位、也不再短路这轮扫描（以前"交集为空 ⇒ 零差异"被当成"就是调用方的前提"，复测者的实测反馈正是从这里读出 `out_of_scope` 恒为 false）。**同一处判据在第九批（G3）接到了"盖章"那一环**：库里只有这种行可顶上支持位时（你问 `cluster=blue`，库里那条写 `tenant=acme`），它也不能换来 `substantiated: true`——裁决转 `out_of_scope`，`scope_conflicts[]` 照旧为空（那行不是冲突，是无从比较），两侧的轴印在 note 里（`scopeCanSupport`，`src/memory.ts:4124`）。排序档位因此订正成**前提一致 > 无前提 > 前提冲突 > 没法比**四档；G1 当时把最后一档与"无前提"并列，#G3-121 否证了它——通说行是一条泛称，写在某个没人问的轴上的行不是。

支持行带前提而提问没给 scope 时，note 会追加 `CONDITIONAL SCOPE` 说明该前提未被核对。中文散文式改写目前基本只剩余弦这一条锚（特征词锚的分词把整段 CJK 当一个词；主体/值锚的解析器要 `主体 -> 值` 写法或英文系动词，中文的 `是` 靠上面 R1 那两条兜法；只有标识符锚与语言无关），判不出时降级为 WEAK_MATCH：**代价是 yes 变少、得回去 `memory_recall` 看那条到底是什么，或直接读码**。这一版订正过的说法是"中文侧不会假阳"——R1 之前它确实会（错误值被盖章），现已闭；剩下的就是少 yes 这个安全方向。

### `memory_maintain` —— 维护（13 个动作）

| 动作 | 作用 | 风险 |
|---|---|---|
| `consolidate` | 高频 episode 抽象成 semantic 规则 | 只新增 |
| `compress` / `undemote` | 图式压缩（预览 → `plan_json` 落库）/ 恢复折叠行 | 折叠可逆 |
| `forget` / `prune` | 衰减弱记忆（默认 dry_run）/ 清理空库文件 | 软删除 / 只删空文件 |
| `stats` / `list` / `history` | 统计 / 清单 / 版本史 | 只读 |
| `duplicates` / `override-audit` / `status` | 重复报告 / 覆盖事故审计 / 嵌入器、库健康与隔壁库诊断 | 只读 |
| `merge` | 把**一个** `duplicates` 组折叠成一条（默认预览，`dry_run: false` 才落地；`into` 可点名留哪条） | 可逆（`undemote`） |
| `delete` | **永久删除**某条（含版本历史） | ⚠️ 不可恢复 |

`duplicates` 的每组带 `mixedPremises`：为真表示**组里至少有一对**行声明了互斥前提（同一句话在两种口径下各是一条痕迹，不是重复）。这类组不是整组作废——`merge` 只把与幸存行前提冲突的那些行留在 `blocked[]`（点名冲突的 key），其余照常折叠；全都冲突时返回 `survivor: null`、一条不动。

`merge` 之后多余行**没有消失**：它们只是被折叠（`demoted`），默认召回不再出现，`list` 仍列得出（行上带 `demoted: true`），`{ action: "undemote", ids: [...] }` 随时恢复。想清重复别用 `delete`——那会连版本历史一起删。

---

## 🔬 召回结果怎么看

**三个分数别混着看。** `memory_recall` 的每个命中带三个数，外加一个不是数的依据标签：

| 字段 | 含义 |
|---|---|
| `similarity` | **原始余弦**。与召回阈值、与 `memory_verify` 同口径，判断像不像以它为准 |
| `score` | 排序分 = `similarity × (0.6 + 0.4 × importance)`，再叠加标识符加成，上限 1.0。**不等于相似度** |
| `relativeScore` | `similarity ÷ 本次最高 similarity`。**组里最好那条永远是 1.000**，它表达排序，不表达置信度 |
| `anchored` / `anchors` | **不是分数**（0.3.2）：这一行与 cue 之间有没有可指认的词法依据，`anchors` 说是哪一档（`identifier` / `entity` / `subject` / `vocabulary`；无 cue 时为 `recency`）。用来把"本次最佳"与"最接近的向量邻居"分开——**`anchored: false` 的排序照样有效，但它不是证据** |

> 三个数是"排第几、有多像"，`anchored` 是"凭什么在这里"。只盯 `relativeScore` 会把 1.000 读成置信度——那是黑盒报告第 4 条的形状。

> 曾有人看到 `memory_verify` 给 0.604、`memory_recall` 只给 0.449，以为 recall 更弱。其实是口径不同：verify 报原始余弦，recall 报含重要性乘数的 `score`。用 `similarity` 就能对上。

**查到空结果时**，返回里会说明原因，不再是一个空数组：

| 字段 | 含义 |
|---|---|
| `reason` | `below-threshold`（有相关记忆但没过阈值）/ `no-candidates`（库里没有或全被筛掉）/ `empty-cue`（没给 query）/ `ok` |
| `eligible` / `bestSimilarity` / `threshold` | 通过筛选的条数 / 候选里最高原始余弦 / 本次生效阈值 |
| `nearMisses` | 最接近的几条（含分值与摘要），一眼看出差一点的是哪条 |

**标识符查询（0x… / D-387 / commit sha）为什么能命中**：裸标识符做嵌入查询余弦极低，但精确 token 命中比余弦更可靠，所以这类记忆即使低于阈值也会召回，并标 `literalMatch`。

**被覆盖的记忆去哪了**：覆盖时返回 `superseded`（被替换的 id / 版本 / 摘要），旧版进 `history` 存档、**不是静默丢弃**；也可用 `override-audit` 事后筛出可疑覆盖。

**写入的结局怎么看**：看 `outcome`，不要数行数——`none`（复述强化）和 `merge`（并入）都不会新增行。

---

## 🔍 常见问题

**Q：旧对话为什么查不到记忆？**
插件只从它装上、启用那一刻开始工作。更早的对话没经过记忆工具，不会自动补录——可在旧对话里要求 agent 用 `memory_remember` 补写要点。

**Q：`memory_verify` 说 UNSUBSTANTIATED，但我明明记过？**
哈希嵌入对同义不同词的召回偏弱（尤其中文）。**推荐开启设置里的嵌入模型 = auto**。也可看 `closest`（最接近的候选是谁）、用更接近原 summary 的措辞再查，或带上实体名。

**Q：`memory_verify` 给了 `weak_match: true`（0.3.2），算不算查到过？**
不算支持，也不算"没记过"——它说的是"有一行相关，但那行没有替你这句话作证"。此前这一格会直接发 `substantiated: true`（实测：库里存着"后端用 Python"，问"Python 是用来煮咖啡的"，0.485 越过召回线 0.32 就盖章），所以 `weak_match` 是**修复而非退化**。拿到它当 false 用：`memory_recall` 翻出那条看它到底说了什么（或直接读码），再判断是不是同一句话；也可换写法重问（带上标识符、写成 `主体 -> 值`、或直接复述原 summary）。**中文散文式改写更容易落到这一格**——特征词锚用的分词把整段 CJK 当一个词，改写后不剩共同词元，于是中文句子基本只剩余弦一条锚（判不出时宁可降级——**注意别把这条读成"不会假阳"**：R1 之前中文的错误值恰恰会被盖章，那一格现在会答 `CONTRADICTED`，见上文）。上面那三种换写法正是绕开这点：标识符锚与语言无关，`主体 -> 值` 结构化写法也不依赖英文形态。

**Q：用中文问 `memory_verify`，值错了它也会说"记住了"吗？（0.3.2 订正）**
不会了，这一条是装机复测抓出来的（R1）。值冲突检查过去要求**双方都解析成功**，而引擎的系动词表只有英文，中文 `X 是 Y` 解析为 `null` → 那条检查对中文整体不可达，错误值被余弦直接盖章：真值 `gto 最大并发连接数 -> 128`，问 `是 512` 得 `substantiated: true`（bge 0.81），而写成 `-> 512` 或英文 `is …` 都正常报矛盾。现在错误值判 `CONTRADICTED`（0.89 / 0.83），note 印 `memory binds "<主体>" to "<库里的值>", not "<你问的值>"`；真值与合法细化照常 `substantiated`（0.91 / 0.81）。旧版文档里"中文侧不会假阳、代价只是 yes 变少"那句是错的，已订正——**剩下的才是那个安全方向**。

**Q：`contradicted: true` 能直接当"记忆里有反证"用吗？（0.3.2）**
能，但要先看 note。以前只要**极性**不一致就判矛盾，而中文的否定字单字即算（`不`/`没`/`未`/`非`），于是一条含"不"的中文记忆能"反驳"任何英文否定断言（`python is not a compiled language` 实测 0.58 判 `contradicted: true`，点名的行毫不相干）。现在矛盾也要结构证据（标识符 / 逐字前缀 / 对方主体 / 实体标签）；凑不齐时 `contradicted` 为 false，note 追加 `NOTE: a nearby trace asserts the OPPOSITE polarity … a coincidence of negation, not a proven conflict.`。**看到这句当"没依据"处理**，别当反证改口。同主体真翻转照旧定案（`runs nginx` vs `does not run nginx`、`支持` vs `不支持`）。写路径的 `suspected_conflict` / `opposite polarity` 覆盖触发**仍用旧的单字极性**（那是 verify 之外的事，见 ROADMAP）。

**Q：前提冲突的那条记忆明明在库里，为什么 `scope_conflicts[]` 是空的？**
先分清四种"空"，它们不是同一个原因：
1. 支持行**自己**就带了冲突前提——那时走的是同一条 `OUT_OF_SCOPE` 出口，否决者就是 support 本身，id 印在 note 里。`scope_conflicts[]` 只在"抢到支持位的那条没有前提冲突、被另一条落选行否决"时才非空。
2. **提问没带 `scope`**：整轮前提扫描不跑（没有"调用方的前提"可核对），此时带前提的支持行只会拿到 `CONDITIONAL SCOPE` 注记。
3. 你期望它否决的那条其实**写在另一条轴上**（你问 `region`，它写 `release=v2`）——那是**没法比**，不是冲突：它不进清单。**不过"不替你的说法背书"这句在 G1 当时只做对了一半**：排序把它压下去了，可库里**只有**这一条带前提的行时，它照样顶上支持位并盖章（复测者的 D5，装机字节下 bge 0.9094 / 哈希 0.846）——那是第九批（G3）修的：这种行自己当上支持行时也转 `out_of_scope`，两侧各自的轴印在 note 里。同一批把档位从 G1 的"与没写前提的同档"订正为四档**前提一致 > 无前提 > 前提冲突 > 没法比**（并列那格由 #G3-121 否证）。以前"交集为空 ⇒ 零差异"被当成"就是调用方的前提"，于是它抢到支持位并顺手短路整轮扫描，那正是 `out_of_scope` 恒为 false 的来路。
4. 它**两条否决路线都没够着**：分数低于所选支持，且与你的问句没有共同的标识符或主张主体。这一形下裁决就按所选支持那一行走（有锚 `SUBSTANTIATED`、无锚 `WEAK_MATCH`），不会因为一条"话题相近而前提不同"的行降成 `OUT_OF_SCOPE`。

**Q：同一句话换个测量口径测出不同数字，会被当成同一条记忆吗？**
会——除非写入时带 `scope`（本包的"前提作用域"一行，0.3.0）。`scope: "population=…; comparator=…"` 声明条件后，前提对不上的两条结论各自留存、互不覆盖；**裸词同样算前提**（`the production cluster`，0.3.2 起收进内部键参与比较，所以裸写与键值写跨形式可比）；查问时也要带 `scope`，否则 `memory_verify` 会用 `CONDITIONAL SCOPE` 告诉你那条支持的**前提没被核对**（`memory_recall` 传 `scope` 则直接把前提冲突的行硬过滤掉）。0.3.2 起 verify 的前提比较**不再只看抢到支持位的那一行**——库里那条属于别的前提的痕迹即使排名靠后也会否决，落选者点名在 `scope_conflicts[]`。不带 `scope` 仍按老规则判（同主体换值 → 覆盖），所以关键是别让 agent 省掉这个参数。

**Q：recall 只给 0.4 多，是不是没记住？**
不一定。先看 `similarity`（原始余弦，与阈值可直接比）与 `relativeScore`（1.0 = 本次最佳）。余弦被压缩，0.45 也可能全库最佳。要判断"这条凭什么在这里"看 `anchored`（0.3.2）——`relativeScore` 是 1.000 而 `anchored: false`，说的是"本组最接近的那条，词法上和 cue 对不上"。若 `reason` 是 `below-threshold`，看 `nearMisses` 判断是真没有还是阈值偏高。

**Q：怎么知道记忆库健康？**
`memory_maintain` → `status`：一句话 `health` + 深度诊断。看到 `WARN: embedder mismatch` 说明模型向量库被哈希回退查询了（会导致永久零命中）。**空库时先看 `health` 是不是先说"写在另一个库里"**（0.3.0）：`sibling_stores` 里隔壁有货而本库 0 行，那是分库路径问题，不是记忆没工作。

**Q：会不会很费 token？**
不会。写入 / 查询是 agent 主动调用才发生；自动注入只在命中相关记忆时产生约 20–40 tok/条，无命中为 0。条数上限可调。

**Q：数据安全吗？**
纯本地 SQLite（`~/.dsh/storages/hippo-memory/`），零外部服务、零网络请求。可选本地嵌入模型增强召回（模型文件也缓存在本地）。

---

## 🗂 数据位置

| 内容 | 路径 |
|---|---|
| 每 agent（通常＝每会话）记忆库 | `~/.dsh/storages/hippo-memory/<agent-id>.db`（实测形如 `session-<id>.db`） |
| 共享记忆库 | `~/.dsh/storages/hippo-memory/shared.db` |
| 嵌入模型缓存 | `~/.dsh/storages/hippo-memory/models/` |
| 插件设置 | `~/.dsh/settings.yaml`（`hippo-memory:` 节） |

删除对应 `.db` 即清空该记忆（建议先退出 dsh）。

## 📄 License

MIT
