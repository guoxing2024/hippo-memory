# 🧠 opencode-hippo-memory

**给 opencode 装上海马体式长期记忆** —— 跨会话、跨压缩、抗遗忘，纯本地 SQLite。

```
没有它：   会话一长 → 上下文压缩 → 早期结论蒸发 → 模型凭印象编
有本插件： 重要结论自动沉淀 → 每轮按需唤起 → 断言前先查证 → 有据才答
```

> 引擎是框架无关的 [**`hippo-memory-core`**](https://www.npmjs.com/package/hippo-memory-core)（自带 Bun 支持，本包需要 `^0.3.2`）；本包是 **opencode 适配层**（当前 **0.3.3**：0.3.2 三枚已于 **2026-10-06 发布 npm**，本枚仅重发文档，代码成员与 0.3.2 逐字节相同；上一发布线 0.3.0）。引擎侧的契约订正在这里透传：话题相近不再算证据（`weak_match`），矛盾一侧同样要锚（含中文的值冲突），前提冲突的行即使没抢到支持位也能否决（`scope_conflicts[]`），召回命中带上 `anchored` / `anchors`。本包另有两条自家缺陷修复：**没声明的参数不再被静默丢掉**（F5）与 **`hitView` 白名单点名新字段**（引擎多出的键不在这里列出就到不了模型，F4b）——所以"无代码改动"那句旧说法已订正。
> 本仓库里的 DSH 版是 [`dsh-hippo-memory`](https://www.npmjs.com/package/dsh-hippo-memory) —— **两个宿主不通用**，别装错。

---

## ✨ 它给 opencode 加了什么

| 能力 | 说明 |
|---|---|
| **4 个记忆工具** | `memory_remember` 写 / `memory_recall` 查 / `memory_verify` 断言前查证 / `memory_maintain` 维护（status / stats / list / history / duplicates / merge / undemote / override-audit / consolidate / forget / delete，共 11 个动作） |
| **每轮自动注入** | 用当前对话当线索，把相关旧结论拼成 `[hippo-memory digest]` 块注入系统提示；**命中才耗 token**。全部低于门槛时不再空白：最接近的那条作为第 1 行给出并标明 `[low-confidence … not a memory]`（0.3.0） |
| **压缩前保住结论** | 会话压缩（compaction）前把持久记忆附进压缩上下文，压缩后不丢关键结论 |
| **使用纪律** | 系统提示追加一小节，教模型 WRITE → RECALL → VERIFY → MAINTAIN，查无实据就说"记不清" |
| **前提作用域** | `memory_remember` / `memory_verify` / `memory_recall` 都接受 `scope`（`key=value; …`，**裸词同样算前提**）：写入换口径的重测各存各的、verify 会答 `out_of_scope`、recall 按前提**硬过滤**冲突行并回 `scopeExcluded`（0.3.0；裸词与键值写跨形式可比 0.3.2） |
| **两条出口都要锚** | `memory_verify` 的 `substantiated` 不再只看"有没有痕迹越过召回线"：必须有锚（同主体不冲突 / 共同标识符 / 逐字复述 / 特征词覆盖 / claim-to-summary ≥ 0.75），否则给 `weak_match: true`。**`contradicted` 同一把尺**：值被绑成另一个（含中文 `X 是 Y` 的问法）或同主体极性翻转才算反证。前提冲突的行**即使没抢到支持位**也能否决，落选者点名在 `scope_conflicts[]`（0.3.2） |
| **重复合并** | `memory_maintain { action: "duplicates" }` 只读报告重复，**两条通道**（每组带 `by`）：`text` 同一句话换个壳、`vector`（0.3.2）换措辞说同一件事（余弦 ≥ `nearDuplicateThreshold`，默认 0.92，组里 `similarity` 是最弱那条边）；两组都带 `mixedPremises`。确认后 `{ action: "merge", ids: [...] }` 折叠成一条：默认预览，`dry_run: false` 才落地，多余行不删、`undemote` 可恢复（0.3.0，向量通道 0.3.2） |
| **隔壁那个库看得见** | `status` 除 `health` / 诊断外，新增 `path_rule`（本项目库文件名的由来）、`sibling_stores`（同目录每个 `.db` 各有多少行）、`coverage`（本进程 digest 门槛的读数）；本库空而隔壁满时 `health` 第一句就是"记在另一个文件里"（0.3.0） |
| **纯本地** | SQLite（`node:sqlite` / `bun:sqlite` 自动选），零外部服务、零 API key、零网络请求 |

---

## 📦 安装

```bash
# 全局（推荐）：所有项目都能用
opencode plugin -g opencode-hippo-memory

# 或者只装在当前项目
opencode plugin opencode-hippo-memory
```

装完**重启 opencode** 生效（配置只在启动时读一次）。

### 确认装上了

```bash
opencode debug info        # plugins: 一行里应出现 opencode-hippo-memory
```

然后随便开一个会话问模型：`"列出你有哪些 memory_ 工具"` —— 能看到 4 个就通了。

### 手动安装（等价做法）

在 `~/.config/opencode/opencode.json`（或项目的 `.opencode/opencode.json`）里写：

```json
{ "plugin": ["opencode-hippo-memory"] }
```

### ⚠️ 一个很容易踩的坑

`plugin` 里写**纯包名**时，opencode 会把它当 registry 规范，去 npm 现装到
`~/.cache/opencode/packages/<spec>/node_modules/opencode-hippo-memory` —— **它不读 `~/.config/opencode/node_modules`**。
所以"在配置目录里手工 `npm install` 一个 tgz"是不会生效的，而且：

- 装失败**不写日志**（服务端加载器的 `missing` 回调是空函数，install 错误只发一条一次性 TUI 提示）；
- `opencode debug info` 里**照样会列出包名**（那只是配置回显，不代表加载成功）。

因此本地开发请用 `opencode plugin <本地目录>`（会解析成 `file://` 规范），或者直接写路径：

```json
{ "plugin": ["file:///absolute/path/to/opencode-hippo-memory"] }
```

排查是否真的加载了，别看 debug info，看**副作用**：跑一轮会话后应出现
`<store 目录>/<项目名>.db`（见下文"数据位置"），或问模型要 `memory_` 工具列表。

升级后版本没变也是这个原因：opencode 的缓存目录按**规范原文**命名
（`~/.cache/opencode/packages/opencode-hippo-memory@latest`），命中就完全不查 registry。
更新要么用 `opencode plugin -g -f opencode-hippo-memory`，要么删掉那个目录再启动。

---

## ⚙️ 设置

插件选项通过 opencode 配置的 `plugin` 二元组传入：

```json
{
  "plugin": [
    ["opencode-hippo-memory", {
      "enabled": true,
      "contextLimit": 5,
      "sharedStore": false,
      "discipline": true,
      "similarityThreshold": null
    }]
  ]
}
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉 = 不注册工具、不注入（**数据保留**） |
| `contextLimit` | `5` | 每轮注入的记忆条数上限 |
| `sharedStore` | `false` | `true` = 本机所有项目共用 `shared.db`；`false` = 每个项目一个库 |
| `discipline` | `true` | 是否追加使用纪律小节 |
| `similarityThreshold` | `null` | 召回门槛；`null` 用引擎默认 0.32。调低更宽松、调高更严格 |

---

## 🧠 怎么让它真的被用起来

插件默认启用，但**工具调用是模型自己决定的**。想在某个项目里让它认真用记忆，把这段贴进 `AGENTS.md`：

```markdown
这个项目启用了长期记忆（memory_* 工具）：
- 学到持久结论、做完决策 → memory_remember（summary 用 <主体> -> <结论>）
- 只在某种条件下成立的结论（样本范围、比较基准、版本）→ 带上 scope: "key=value; key=value"
- 回答涉及旧事实/旧决策 → 先 memory_recall，别只凭当前上下文猜
- 断言记忆里的东西之前 → memory_verify（问的也是同一个 scope）；没依据就说"记忆里没有"，
  out_of_scope 就说明库里那条属于别的前提，不要搬用
- 只有 substantiated: true 可当"记住的事实"复述；weak_match: true 也是没依据，
  不许读它的 support 升成 yes（去 memory_recall 看那条原文，或直接读码）
```

---

## 🔬 召回结果怎么看

`memory_recall` 的每个命中带**两个分数**（本包的视图只转发这两个；引擎另有排序用的 `score`，它不出这个出口）和一个**不是分数**的依据标签：

| 字段 | 含义 |
|---|---|
| `similarity` | **原始余弦** —— 与门槛、与 `memory_verify` 同口径，判断"像不像"用它 |
| `relativeScore` | 本次查询内的相对分 = `similarity ÷ 本组最高 similarity`。**组里最好那条永远是 1.000**：它表达排序，不表达置信度 |
| `anchored` / `anchors` | 0.3.2：这一行与 cue 之间有没有可指认的词法依据，`anchors` 说是哪一档（`identifier` / `entity` / `subject` / `vocabulary`；无 cue 时为 `recency`）。**`anchored: false` 的排序照样有效，但它不是证据** |

查不到时不给空数组，而是说明原因：`reason` = `below-threshold`（有相关但没过门槛，看 `nearMisses`）/ `no-candidates`（库里没有或全被筛掉）。`memory_recall` 从 0.3.0 起接受 `scope`：传了就按前提**硬过滤**冲突行（属于别的前提的行整条排除），返回里 `scopeExcluded` 计数排掉了几条。

写入的结局看 `outcome`，不要数行数：`new` 新增 / `none` 复述强化（不新增行）/ `merge` 并入 / `override` 同主体换值（旧版归档、带 warning 指名退役对象）/ `supersede` 显式退役。命中与写入结果都带 `scope`（这条结论声明的前提，未声明为 `null`）；带前提的新写与库里的旧前提对不上时走 `new` 并附 `different-scope:` 警告，而不是覆盖。`memory_remember` 复述时若带上新证据（`verify_result:"pass"`），返回顶层回显 `verify_result` / `verified_at`（没带证据为 `null`）。

`memory_verify` 的裁决有**五种**（0.3.2 起）：SUBSTANTIATED（有痕迹且**有锚**）、CONTRADICTED（库里持有反证 / 更新版本，**同样要有锚**）、OUT_OF_SCOPE（最接近那条属于别的前提）、**WEAK_MATCH**（`weak_match: true`：有痕迹越过召回线，但没有锚——只是话题相近）、UNSUBSTANTIATED（没记过）。只有第一种能当"记住的事实"复述。"锚"指：同一主体且值不冲突 / 共同标识符（工单号、sha、版本号）/ 痕迹逐字带着这句话 / 痕迹承载了这句话的特征词 / 以上都没有时 claim-to-summary 余弦 ≥ 0.75。**锚命中了还要过三道 belt**（极性相反 / 两边点名的编号不一致 / **两句话只差一个词，而动的是值位或主语位**），任一成立就降成 `WEAK_MATCH`。**光抬门槛修不了这个缺陷**：实测一个幻觉与一句合法改写在哈希嵌入空间里都是 0.444，分不开它们。前提方面，与你 `scope` 冲突的行即使没抢到支持位也会否决，落选者点名在 `scope_conflicts[]`（支持行自己就冲突时该清单为空，否决 id 印在 note 里）。**够得着否决有两条并列路线**（0.3.2）：分数不低于所选支持，**或**它与你的问句说的是同一件事（同一标识符 / 同一主张主体）——**只是实体相同不算**，`api` 这类词在记过同一服务两件事的库里到处都在，那是话题不是断言。这一条对本包尤其直接：`entities` 在 opencode 这边是**可选**字段，随手写的行常常不带实体，旧规则"必须实体重叠才能否决"对整个面等于没有否决（适配层那条**不带 `entities` 的复测**就是钉这一形的）。另一条同一批订正过的边界：写在**你没点名的那条轴**上的前提（你问 `region`、它写 `release=v2`）既不是冲突也不是同意，是**没法比**——它以前会被读成"前提一致"而抢到支持位，并短路整轮冲突扫描，那正是 `out_of_scope` 恒为 false 的来路。

**本包特别相关的一条（装机复测 R1）**：引擎的值冲突检查过去要求**双方都解析成功**，而它的系动词表只有英文，所以中文 `X 是 Y` 的问句解析为 `null` → 那条检查对本包最常见的中文散文写入**整体不可达**，错误值直接被余弦盖章成 yes（实测真值 128、问 `是 512` → `substantiated: true`，bge 0.81）。现在它多了两条兜法（只有一边解析时用那一边的主体去另一方文本开头找值；两边都不解析时比"逐字前缀之后第一个数"），中文的错误值也判 `CONTRADICTED`，note 印 `memory binds "<主体>" to "<库里的值>", not "<你问的值>"`。**这条修复没有给解析器加中文系动词**——那会连带改动写入端判定，且切错的方向是"升成 yes"。

**矛盾这一侧也要锚（装机复测 R2）**：以前只要极性不一致就判矛盾，而中文的否定字单字即算，于是一条含"不"的中文记忆能"反驳"任何英文否定断言（`python is not a compiled language` 实测 0.58 判 `contradicted: true`）。现在这类要有结构证据（标识符 / 逐字前缀 / 对方主体 / 实体标签）才定案，否则只在 note 里追加 `NOTE: a nearby trace asserts the OPPOSITE polarity … a coincidence of negation, not a proven conflict.`，`contradicted` 保持 false。**处置**：见到这条 NOTE 当"没依据"用，别读成"记忆里有反证"。

**换了号就不是同一件事（装机复测 R3）**：库里 `KAPPA-1 record`、问 `KAPPA-2 record`——这两个**不同工单**以前被读成"同一主体换了值"而判 `contradicted: true`（标识符尾部的数字被当成值，note 印 `binds "…kappa-" to "1"`）。只修这一半会朝更危险的方向倒：同一对形状改判 `substantiated: true`，bge 下实测最高 0.982。于是锚点又加一条：两边各自点名的编号对不上时，靠共有措辞撑住的锚不成立，**结局落 `WEAK_MATCH`** 并在 note 里点名两个标识符。

**这条护栏认的编号比你以为的宽，而且它对本包不再默认惰性（R4 / R4b / R4c）**：R4 由复测者定性为 R3 那次修复**引入的回归**——`2024z` 对 `2025z`、`2025Q1` 对 `2026Q1` 这类**数字开头**的 label 当时的 belt 认不出来，于是盖章 yes；更早的构建反而挡住了它，靠的是那个切片 bug 把 `4z` 读成了"值"（方向对、理由错）。R4b 又发现只给正则加分支不够：判据问的是"两个集合是否互不相交"，所以**取出共享前缀就会抵消这条否决**（`probe-k8 2024z` 当时被降级，恰恰因为没分支取出 `probe-k8`）。现在一条 label 规则取代形状表：**以 `- _ . : /` 相连的字母数字极大串、且含至少一个数字**；判据改读背离——**两边各有一个对方没有的 label 就否决**，共享前缀再长也不构成抵消。对本包的实际含义：`2024-05-01`、`v1.2.3`、`10.20.30.41`、`us-east1a`、`h7` 现在都算编号，即使那条行不带 `entities`、不带工单号，护栏也会生效（不含数字、又不是 ≥7 位 hex 的词不算——而且因为那条极大匹配连裸词一起收，这道过滤挡的是**所有普通词**（`commit` 也算一枚匹配），不只是 `long-tailed` 这种连字词；**但一整串本身是 ≥7 位十六进制时纯字母也算**——`commit deadbeef` 对 `commit cafebabe` 是两个不同的 sha，这条例外是 R4c 补的，而 R4c 是作者自己抓到的：第一版加上"必须含数字"时把旧形状表里 `[0-9a-f]{7,40}` 那一支的覆盖顺手废掉了，完全没有数字的 sha 因此不再是 label，单臂减法看不见这一形），而 `long-tailed` / `short-tailed`、`readwrite` / `readonly` 这类**词例**现在由下面 V1 那条**位置** belt 接住，不再依赖这道数字过滤）。它仍然**只降级、从不收紧**，所以后果只是"多落一些 `WEAK_MATCH`"；反过来，**只有痕迹多说了编号而你的断言没提**时不否决（那是库里更细，仍算支持）。**处置**：要让它替你保住"别把两件事说成一件"，就把编号逐字写进句子、问的时候也带上。中文散文式改写的边界仍是下一条。

**只差一个词，就不是同一件事（V1，第五轮普查）**：库里 `gto deploys to staging cluster`，问 `gto deploys to production cluster` —— 此前这里给的是 `substantiated: true`（哈希 0.75 / bge 0.87），因为五枚锚里没有一枚读"值"这一位；报告者把 `production` 换成一个**根本不存在的词** `zzzqqq`，照样盖章（0.77 / 0.83），这就排除了"补一张环境名词表"这条路。现在第三条 belt 读**位置**：词数相同、只在一个位置上不同、而该位置两侧都是能承载值的词，就降成 `WEAK_MATCH` 并在 note 里点名两个值。**这一枚对本包尤其有价值**：它不要求那条行带 `entities`、不要求句子里有工单号 / sha、也不要求句式落在系动词表内——本包宿主写下的正是这种无结构散文行。**它给的是 `WEAK_MATCH` 而不是 `CONTRADICTED`**：一个谓词可以对多个值同时为真，写成 `主体 -> 值` 或系动词句式时才走反证，那条路一行没动。已量的边界：不带空格的中文（连召回线都过不了）与一次改两个词的改写仍在机制之外。

**中文散文式改写更容易落到 WEAK_MATCH**：特征词那条锚走 `tokenize`，它把整段 CJK 当一个词（`tokenize('Python 是用来煮咖啡的')` → `["python","是用来煮咖啡的"]`），改写后不剩共同词元；主体/值那条的解析器要 `主体 -> 值` 写法或英文系动词（中文的 `是` 靠上面 R1 那两条兜法）；只有"共同标识符"与语言无关（句中得有工单号 / sha / 版本号）。所以中文改写常常只剩余弦这一条锚，代价是 **yes 变少**。别把这条读成"不会假阳"——那是本版订正掉的说法，真会假阳的那条已经由 R1 关掉，剩下的才是安全方向。

---

## 🗂 数据位置

| 内容 | 路径 |
|---|---|
| 每项目记忆库 | `<store 根>/<项目目录名>.db` |
| 共享记忆库（`sharedStore: true`） | `<store 根>/shared.db` |

`<store 根>` 按环境解析：设了 `XDG_CACHE_HOME` 用它（`$XDG_CACHE_HOME/opencode/hippo-memory`）；
Windows 用 `%LOCALAPPDATA%\opencode\hippo-memory`；其余平台用 `~/.cache/opencode/hippo-memory`。
删除对应 `.db` 即清空该项目的记忆（建议先退出 opencode）。

---

## ❓ 常见问题

**Q：和 `dsh-hippo-memory` 什么关系？**
同一个引擎的两个宿主适配层，**互不通用**：DSH 用前者，opencode 用本包。数据也不通用——DSH 按 agent id 分库（`~/.dsh/storages/hippo-memory/`），opencode 按项目目录分库（`<缓存根>/opencode/hippo-memory/`）。在 DSH 里记下的结论，到 opencode 查就是"没记过"；反之同理。

**Q：换个项目 / 换个会话就查不到了？**
先分清两种"查不到"。本包默认**每个项目目录一个库**：A 项目的结论在 B 项目里本来就读不到（不是没记住）。想全项目共用一个库，把 `sharedStore: true` 写进 `plugin` 的设置项。判据在 `memory_maintain { action: "status" }` 里（0.3.0）：`path_rule` 说明这个文件名怎么来的，`sibling_stores` 列出同目录每个 `.db` 各有多少行，本库 0 行而隔壁有货时 `health` 直接说"记在另一个文件里"。

**Q：装完没反应？**
先看上面"⚠️ 一个很容易踩的坑"——`opencode debug info` 列出包名**不代表加载成功**。按顺序查：
重启 opencode（配置只在启动时读）→ 跑一轮会话，看 store 目录里有没有生成 `.db` → 没有就确认包已发布到 npm
（`npm view opencode-hippo-memory version`）且 `plugin` 里是纯包名或有效的 `file://` 路径。

**Q：会多花很多 token 吗？**
自动注入**命中才发生**（每条约 20–40 token），没命中就是 0；条数用 `contextLimit` 控。工具调用只在模型主动用时发生。

**Q：查旧结论查不到？**
先 `memory_maintain` → `status`：一句话 `health` + 诊断（驱动、向量维度、`dimMismatch`、阈值）。默认哈希嵌入只认字面词，中文同义改写召回偏弱——换成语义模型（引擎侧 `setEmbedder()`）或把 query 写得贴近原文。

**Q：`memory_verify` 返回 `weak_match: true`（0.3.2），是插件变严了吗？**
是它以前太松。这一格过去会直接发 `substantiated: true`——库里存着"后端用 Python"，模型幻觉出"Python 是用来煮咖啡的"，余弦 0.485 越过召回线 0.32 就盖了章，**比不查更危险**（拿到 yes 的模型不会回去读码）。现在把"话题相近"如实标成相近：`weak_match: true` 当 false 用，去 `memory_recall` 看那条原文或直接读码；也可以换写法重问（带标识符、写成 `主体 -> 值`、复述原 summary）。想靠抬门槛解决不行——实测幻觉与合法改写在哈希空间里都是 0.444。

**Q：用中文问 `memory_verify`，值错了它也会说"记住了"吗？（0.3.2 订正）**
不会了，但这一条是装机复测抓出来的（R1）。引擎的值冲突检查过去要求**双方都解析成功**，而它的系动词表只有英文，中文 `X 是 Y` 解析为 `null` → 那条检查对中文写入整体不可达，错误值直接被余弦盖章：真值 `gto 最大并发连接数 -> 128`，问 `是 512` 得 `substantiated: true`（bge 0.81），而写成 `-> 512` 或英文 `is …` 都会正常报矛盾。现在错误值判 `CONTRADICTED`（0.89 / 0.83），note 印 `memory binds "<主体>" to "<库里的值>", not "<你问的值>"`；真值与合法细化照常 `substantiated`（0.91 / 0.81）。**别把这条订正读成"中文侧本来安全"**：上一版文档写的正是那句，而它是错的。

**Q：`contradicted: true` 能直接当"记忆里有反证"用吗？（0.3.2）**
能，但要看 note。以前只要**极性**不一致就判矛盾，而中文的否定字单字即算（`不`/`没`/`未`/`非`），于是一条含"不"的中文记忆能"反驳"任何英文否定断言（`python is not a compiled language` 实测 0.58 被判 `contradicted: true`，点名的行毫不相干）。现在矛盾也要有结构证据（标识符 / 逐字前缀 / 对方主体 / 实体标签）；凑不齐时 `contradicted` 为 false，改为在 note 里追加 `NOTE: a nearby trace asserts the OPPOSITE polarity … a coincidence of negation, not a proven conflict.`。**看到这句就当"没依据"处理**，别当反证改口，也别据此断言"记忆里说反话"。同主体真翻转照旧定案（`runs nginx` vs `does not run nginx`、`支持` vs `不支持`）。

**Q：同一句话换个测量口径测出不同数字，会被当成同一条记忆吗？**
会——除非写入时带 `scope`（`key=value; key=value`，如 `population=all rows; comparator=instruction start`，0.3.0）。带上之后：前提对不上的两条结论各自留存、互不覆盖（写入回显 `different-scope:` 警告）；`memory_verify` 也要带 `scope` 问，库里那条属于别的前提时它答 `out_of_scope`（`substantiated`、`contradicted` 都为 `false`），而不是把旧口径的结论盖到新口径的问题上。**0.3.2 起这个否决不再只看抢到支持位的那一行**：此前一条没写前提的行顶上来时，库里那条 `env=prod` 的冲突痕迹会被降进 `newer_related[]`、`out_of_scope` 仍是 `false`（反馈实测）；现在整个过线候选集都参与比较，落选的否决者点名在 `scope_conflicts[]`。**第九批（G3）补上另一半**：顶上支持位的那条行如果自己就写在**你没点名的那条轴**上（你问 `cluster=blue`，库里那条写 `tenant=acme`），它同样不能换来 `substantiated: true`——转 `out_of_scope`，`scope_conflicts[]` 为空（那不是冲突而是没法比），两侧的轴印在 note 里。

**Q：压缩之后记忆还在吗？**
在。数据在 SQLite 里，与上下文无关；本插件还会在压缩前把持久记忆塞进压缩上下文 (`experimental.session.compacting`)，减少"压缩后忘事"。

---

## 📄 License

MIT
