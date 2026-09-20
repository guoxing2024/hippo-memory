# Changelog

## [0.3.0] — 2026-09-20

### Added — 第二轮专家审计落地（信任分级 / 三态裁决 / LLM 巩固钩子 / 遗忘保护 / scope 读取过滤）

- **信任分级（审计 #5）**：`remember` 新增 `verifyAttested`。引擎从不执行 `verify_cmd`，因此 `pass` 分两档：**attested**（调用方声明检查在可复现环境中实际执行过）→ 渲染 `[VERIFIED]`、保留完整退休护盾；**self-reported**（默认，诚实但自我声明）→ 渲染 `[VERIFIED self-reported]`，护盾**降级为显式警告**（`shield-note: … SELF-REPORTED …`），覆盖照常进行、旧版本留在历史。空口徽章不再守护数据。
- **三态裁决（审计 #3）**：`sourceMonitor` 返回值新增 `contested`。布尔契约不变（肯定匹配仍 substantiated），但当支撑行不是其前提下的最新结论、或邻域存在反方时 `contested: true` 并在 note 里标注 `CONTESTED:`——"是"不再是一个裸布尔。
- **LLM 巩固钩子（审计 #4）**：`new HippoMemory({ summarizer })` / `setSummarizer()`。`consolidate()` 优先把合格 episode 交给 summarizer 做真正的泛化（可返回多条规则），抛错或返回空回退到原 `FACT:` 模板——巩固永不失败。文档此前声称的"接口已预留"现在真实存在。
- **遗忘零召回保护（审计 #7）**：`forget()` 新增两道窄守卫——`forgetGraceSec`（默认 14 天）内的新行**既不遗忘也不衰减**；带新鲜证据的行豁免（证据行被遗忘等于丢弃审计链）。`force` 仍是显式冲洗的逃生门。返回值新增 `spared[]` 以便观察。这打断了"弱嵌入器 → 召回失败 → access 不涨 → 衰减 → 遗忘"的负反馈环。
- **scope 读取硬过滤（审计 #7/#8 收敛步）**：`recall(cue, { scope })` 把前提冲突的行**排除出结果**（计数进新字段 `scopeExcluded` 并附 `scope:` 警告）；未声明前提的行照常通过（没写前提 ≠ 反对前提）。opt-in，默认读取路径不变。
- **bench 对照臂（审计 #6 部分）**：`anti-hallucination-bench` 新增**朴素全文 RAG 臂**（同嵌入器、同抽取规则）。当前读数：RAG 编造率 63%（自信召回被更正前的旧值）vs HippoMemory 25%——量化"版本化纠正链"相对朴素向量检索的增量。INTRO 的效果数字同步改为对照结构口径（检索臂模拟、n=8，真实 LLM 端到端基准仍待补）。
- **审计 #0**：DSH 适配层嵌入默认从 `off` 翻转为 `auto`（本地语义模型，懒加载，失败回退哈希）；`off` 成为显式退出项。GUI 选项文案同步标注推荐值。
- **值矛盾判定精化（承接上轮审计 #7）**：same-subject 值比较从裸字符串改为**词元级**（去掉连接词、包含即精化、IoU<0.5 才算冲突）——"uses github actions **and** caches node_modules" 与漏掉 and 的复述不再被误判为矛盾（修复了 memory.test 的 supported-claim 误报）；值矛盾的早返回现在**携带 supersedes 链与归档版本**（`superseded_matches` + `archived vN` 注记），问旧值不再得到"从未存在"的假答案。

### Fixed — 上轮审计遗留的两处测试-实现冲突

- `scope.test`"前提感知选择"用例按新契约改写：换口径追问同主体异值结论现在正确判 `CONTRADICTED`（点名不同意的那行），其自身口径下仍 `SUBSTANTIATED`。
- `evidence.test` S2 系列按信任分级改写；新增 `test/audit2-round.test.mjs`（11 项）锁定本轮全部新契约。

### Fixed — 第九轮实测反馈：`sourceMonitor` fuzzy 归档层误报（`contested` 假阳）

- **fuzzy 归档匹配加主体相关性闸门**：`sourceMonitor` 的模糊归档层此前只按 cosine 收录归档修订——一个**自身值翻转过、又与 claim 有词面重叠的无关主体**（实测 `backup queue` vs `primary queue`，sim ~0.62）会被塞进 `superseded_matches`，连带把 `contested` / `stale_support` 误置为 `true`。现在 fuzzy 分支要求该行**与支持行共享实体**（除非它就是支持行本身）才纳入；exact 复述层（similarity=1）不设闸——字面全等本身即决定性证据。支持行**自己的**归档修订照常带出，不受影响。
- 新增两项回归用例（`audit2-round.test.mjs`，共 15 项）：`fuzzy-archived flip on an unrelated subject never contests`（用词面兄弟主体复现实测误报，关闸即红）与 `support row's own archived flip still surfaces`（防闸门过宽误伤支持行自身历史）。

## [0.3.0]（续）— 前提作用域 `scope` + 重复合并 + 兜底提示 + 库分裂可见

> 四条改动来自同一份外部实测反馈，共同点是**把"看起来没有"和"其实不是那样"区分开**：verify 不再拿旧口径的答案给新问题盖章（① `scope`）；重复报告不再诱使你把两种前提下的同一句话折成一条（② `merge` + `mixedPremises`）；召回没过门槛时不再静默空白，而是把最接近的痕迹标明身份给出（③）；一条记忆都没召回时，先看清是不是读错了库文件（④）。

### Added — ① `scope`：把"断言集合"升级为"带前提的断言集合"

- **新字段 `scope`**（`MemoryPayload` / `StoredMemory` / `RelatedTrace`）：`key=value` 段，`;` / `,` / 换行分隔，`=` 或 `:` 皆可（例：`population=all records; comparator=instruction start`）。进嵌入文本，因此同时影响召回排序。
- **判定完全结构化，未新增相似度阈值**（`diagnostics().thresholds` 与设置项一个数都没变）：只比较双方都点名了的 key（只有一方写的 key 视为补充条件，不算反对）；value 按词集合比较——剔英文停用词、latin / 数字整段成词、中文逐字成词（比嵌入器更细的粒度，避免中文改写被误判成新前提），一方包含另一方或交并比 ≥ 0.5（内部常数）判兼容。任一方没写 scope 时**永不判为冲突**，转为"前提未核对"提示。
- **写入端 `remember()`**：与更接近的存量行前提冲突时不覆盖、不合并 → `outcome:'new'` + `different-scope:` 警告（点名被顶住的行与冲突的 key，同一 id 只计一次）；前提一致照常走强化 / 版本化覆盖；重述时若存量行缺前提而新写带了，把前提**补到原行**而不是另起一行。`update()` 换前提时旧前提照常进 `history`。
- **读取端 `sourceMonitor(claim, { scope })`**：过门槛候选里**优先选前提一致的那条**当支持（字面更接近的外前提行让位）；前提冲突 → 新增返回字段 `out_of_scope: true`，`substantiated` / `contradicted` 双假、四组证据清空，note 以 `OUT_OF_SCOPE:` 开头并给出两条出路（在痕迹自己的前提下复查 / 带自己的 scope 另记一条）。SUBSTANTIATED 与 CONTRADICTED 路径显式带 `out_of_scope: false`。
- **前提没被核对时不静默**：支持行带前提而调用方没给 scope → note 追加 `CONDITIONAL SCOPE — …that premise was not checked`；给了 scope 而支持行没带 → note 说明无从核对。
- **透出**：`composeContext` 渲染 `[scope: …]`（与其它字段同样过注入清洗），`recall` 命中、`neighbours[]`、`history()` 均带 `scope`。
- **旧库零迁移**：`memories.scope` 与 `memory_history.scope` 走 `ensureColumns()` 的 `ALTER TABLE` 补列，存量行读作"未声明前提"；不带 scope 的读写路径行为不变（回归测试锁定）。另有删列后重开库的迁移测试：补列 → 新写能带前提。

### Added — ② `mergeDuplicates()`：把 `duplicates` 报告变成可执行的一步

以前 `duplicates` 只能"看一眼再手动 `delete`"，而 `delete` 会连版本历史一起删掉。现在有一条明确的合并动作，DSH 与 opencode 都叫 `memory_maintain` 的 `merge`。

- **引擎 `mergeDuplicates({ ids, into?, dryRun? })`**：只吃**一个**重复组的 id（≥2）。留下的行按"有通过的证据 > 访问次数 > importance > 版本号 > 最早写入"挑，`into` 可显式指定；`dryRun` 只预览不动库（适配层默认就是预览，`dry_run:false` 才落地）。
- **合并 = 折叠，不是删除**：多余行走 `compress` 同一套 demote 机制，**留在库里**、默认召回不再出现、`list()` 一直列出它们（行上带 `demoted: true`，`recall(..., { includeDemoted: true })` 才把它们放回召回）、`undemote` 随时恢复。opencode 此前没有 `undemote` 动作，本次一并补上（否则提示语里承诺"可回滚"就是假的）。
- **信息只增不减**：先把被并行的实体、标签、更长的 `detail`、更高 importance 结转给幸存行，**再**退役它们（顺序写在注释里：中途崩溃只会留下"没并完"，不会留下"信息丢了"）。返回 `carried[]` 明说结转了什么。
- **三种拒绝**：① 与幸存行前提冲突的行 → 进 `blocked[]` 并给出冲突 key（"同一句话在别的条件下仍是它自己的痕迹"）——只有这些行不折，组内与幸存行前提相符的行照常折叠；② id 之间不是同一断言的重述 → 直接抛错；③ `retraction` / `guard` / `invariant` 标记行不参与合并（它们本来就是浓缩结果）。
- **`duplicates()` 报告同时变宽**：每组每行新增 `scope`，组级新增 `mixedPremises: true/false`——定义为"组里至少有一对行前提互斥"（不是"整组都不是重复"）。两个适配层的提示语据此写成"这样的组不要顺手折成一条"，而引擎的实际行为更精确：与幸存行前提相符的行照常折叠，冲突的行留在 `blocked[]`；全都冲突时 `survivor` 返回 `null`、一条不折。
- **DSH 的 `list` 输出补 `demoted` 字段**：折叠行本来就一直在清单里，但没有任何标记，agent 分不清哪条被折过、也就取不到 `undemote` 要用的 id——"可回滚"这句承诺在工具面上是断的（opencode 直接返回引擎对象，本来就有这个字段）。测试同时锁住两家的清单里能读出被折行的 id。

### Added — ③ 门槛没过时不再空白：最接近的痕迹标明身份给出 + 覆盖率计数

原来"库里没东西"和"最像的那条只打了 0.31（门槛 0.32）"输出的是同一句"没有相关记忆"，而后者才是值得看的信号。

- **`composeContext`**：命中为空且召回原因是 `below-threshold` 时，把最接近的那条作为**第 1 行**渲染，标 `[low-confidence sim 0.31 < floor 0.32: the closest trace, not a memory — verify before asserting]`，并带一条 warning 说明身份。它**不借用**原行的 `[VERIFIED]` / `[ASSERTED]`（没过门槛就没有资格声称证据等级）；`items[0].lowConfidence === true`，程序侧也能判。
- **不给猜的地方**：相似度为 0（完全没有词面重叠）或库为空 → 仍然只出状态行，不塞任何东西。`{ lowConfidenceTop1: false }` 可整体关掉。
- **不再用 `[recent]` 顶坑**：零命中时补近况的分支被撤回（那会让通道看起来健康，实际每次都在端出最后几条写入），改为显式状态行 + warning。这是本批唯一的行为契约变更，`test/memory.test.mjs` 相应改写为"不得出现未被标明的填充行"。
- **`diagnostics().coverage = { turns, misses, guesses, scope: 'process' }`**：本进程调过多少次门槛、多少次什么都没放行、其中多少次给出了标明身份的猜测。`misses / turns` 就是召回命中率。刻意**不落库**——持久化计数器会被读成历史，而它回答的是"这次会话里记忆系统有没有在起作用"。

### Added — ④ `status` 看得见"隔壁那个库"：`sibling_stores` / `scope_rule`

DSH 按 agent id 分库、opencode 按项目目录分库，于是"没记住"和"记在另一个文件里"在工具输出里长得一模一样。这是实测里两个库各存各的那类事故的诊断入口。

- **引擎新增导出 `surveyStores(dir, { current })` 与 `SCOPE_RULE`**：前者照 `prune` 已有的走目录方式，把目录里每个 `.db` 打开数一遍行数（`rows` 与 `stats().active` 同口径、`demoted` 单列、`lastWrite` 取 mtime、`current` 标出调用者自己），按行数从多到少排；打不开的文件进 `unreadable[]` 而不是让整份报告消失。后者把"记忆不会跨库文件流动"这条契约写在引擎里一处，适配层各自只补一句"本宿主的文件名是怎么来的"。
- **`diagnostics()` 多两个字段**：`sibling_stores`（上面那份）和 `scope_rule`；`suspicious` 多一个 `emptyWhileSiblingsFull`——本库为空而隔壁有货。`:memory:` 库不扫目录（`dirname(':memory:')` 是 `.`，那会把进程恰好启动在哪个目录里的 `.db` 全列出来）。
- **两个适配层的 `status` 各加 `path_rule`，`health` 判定顺序改为"先看库分裂"**：空库 + 隔壁满 → 直接说"这条记忆写在另一个库里"（DSH 点名 agent 维度，opencode 点名项目维度并提示 `sharedStore`），其次才是原来那条嵌入器不匹配。`diagnostics` 整体透出，所以 `sibling_stores` / `scope_rule` / `coverage` 在两家 `status` 里都能直接读到，不需要改渲染层。
- **顺带补齐 opencode 的一部分清洗面**：`duplicates` 报告与新增的 `merge` 输出（含引擎抛回的拒绝理由）一律过引擎 `sanitizeMemoryText`，与 DSH 的 `list` 一致。注意 opencode 的 `list` / `history` / `recall` 命中仍**没有**清洗（只有自动注入的 digest 经引擎清洗），是遗留缺口，本批未动，见 ROADMAP。

### Fixed

- **`SqliteStore` 构造失败会漏掉文件句柄**：开库成功后建表 / 补列抛错（典型情形：目录里躺着一个不是 SQLite 的 `.db`）时，句柄不释放。Windows 上这会把该文件锁到进程结束，只读探测都变成"删不掉"。现在构造失败前先 `close()` 再抛。`pruneEmptyStores` 里有同样的模式，一并受益。

### Tests

- 引擎新增 32 项：`test/scope.test.mjs` 12（写读往返、无 scope 时 verify 行为不变、前提匹配即支持、`OUT_OF_SCOPE`、`CONDITIONAL SCOPE` 注记、前提一致的痕迹压过字面更接近的外前提行、不同前提各成一条痕迹、同前提仍复述强化、`update` 归档旧前提、补录缺失前提、旧库迁移、`different-scope:` 不重复计数）+ `test/merge-duplicates.test.mjs` 7（预览、落地后 `undemote` 往返、证据持有者幸存并继承实体、混合前提拒绝、无关 id 抛错、标记行抛错、报告带 `scope` / `mixedPremises`）+ `test/digest-top1.test.mjs` 5（低于门槛仍给最接近痕迹并标明身份、零重叠不给猜、空库只出状态行、正常命中不加标记、`coverage` 计数）+ `test/survey-stores.test.mjs` 8（空目录 / 缺目录、逐库计数与 `current` 标注、demoted 单列、非库文件进 `unreadable` 且不致命、`diagnostics` 透出、空库隔壁满 / 无隔壁两种情形、`SCOPE_RULE` 文案）。
- 适配层新增 10 项。DSH 5：`scope` 参数与 `OUT_OF_SCOPE` 回显、`duplicates → merge` 预览到落地、混合前提组不整组作废（`blocked[]` + 其余照常折叠）、`status` 点名库分裂、**使用纪律文本本身被断言**（`GUIDANCE` 必须点名 `duplicates` / `merge` / `low-confidence`，否则模型看不到这条清理路径）。opencode 5：`scope` / `OUT_OF_SCOPE`、`duplicates → merge` 预览到落地、`merge` 不折不同前提、`status` 的 `path_rule` 与"隔壁那个库"提示、`DISCIPLINE` 同样点名 `merge` 与 digest 的猜测行。
- **全量 194 项通过 / 0 失败**（引擎 142 + DSH 35 + opencode 17；`npm test` 会先 `tsc` 构建再跑）。本批基线是 152 项（引擎 110 + 适配层 42），新增即上面 42 项。


## [0.2.1] — 2026-09-18

### Added — Bun 运行时支持（引擎现在直接跑在 opencode 里）

- **运行时 SQLite 绑定（新文件 `src/sqlite-runtime.ts`）**：引擎此前静态 `import { DatabaseSync } from 'node:sqlite'`，这在**加载期**就决定了它只能跑在 Node ≥ 22.5 —— 而 opencode 等 Bun 宿主（实测 Bun 1.3.14）里该内置模块尚不存在，报 `No such built-in module: node:sqlite`，连 `import` 都失败、无法 catch。现在驱动在加载期探测（Bun 有 `bun:sqlite`、Node 有 `node:sqlite`），并通过 `createRequire` / `process.getBuiltinModule` **惰性**加载，模块图里不再出现当前运行时无法解析的说明符：**导入永不抛错，只有真正开库时才会报错**（且信息里写清该升级什么）。
- **导出运行时信息与自定义驱动**：新增 `sqliteDriver`（值为 `'node:sqlite'` / `'bun:sqlite'`）、`setSqliteDriver(ctor)`（自备适配器，例如 `better-sqlite3` 或测试替身）、以及 `SqliteStatementLike` / `SqliteDatabaseLike` / `SqliteDatabaseCtor` 类型。
- **Bun 侧适配细节**：`bun:sqlite` 的 `Database@ 被包装成 `DatabaseSync` 的最小同构面（`exec` / `prepare` / `close`，语句对象已含 `run` / `get` / `all`，且 `prepare()` 自带语句缓存）。Bun ≥ 1.4 实现了 `node:sqlite`，届时自动优先走 Node 驱动，无需改代码。
- **store 自建父目录**：两个驱动在**父目录不存在**时都只报 `unable to open database file`（新项目 / 新 profile 首次运行的坑，Bun 上尤其容易撞上）。开库时现在会自动 `mkdir -p` 目标目录。

**实测（opencode 1.18.31 / Bun 1.3.14，真实 npm 包、无打包、无垫片）**：

```
import("hippo-memory-core") -> driver=bun:sqlite
remember -> outcome: new / override（旧版归档，warning 指名退役对象）
recall   -> 命中 mysql（sim 0.733），reason=ok
verify   -> superseded_matches=[postgres]（旧值可见）
digest   -> [memory data …] 数据框架正常
```

### Notes

- **Node 侧零影响**：`sqliteDriver` 在 Node 上仍是 `'node:sqlite'`，137 项测试全绿（新增 1 项运行时绑定测试）；引擎行为、数据格式、阈值全部未变。
- 数据文件格式不变，**旧库零迁移**。

## [0.2.0] — 2026-09-18

> **大版本：抗幻觉四件套（证据 / 撤回 / 前瞻 / 值域）+ 纠正链 + 投毒防护 + 可观测性。**
> 本版把此前所有未发布改动合并为一个号，并修掉了实测反馈中唯一会造成**数据丢失**的一类事故——无 warning 的静默覆盖（BUG-1 及其复发）。
> 升级提示：覆盖判定更严、渲染新增证据前缀与数据框架、maintain 新增动作，但**旧库零迁移**、API 无破坏性改名；见 README「从 0.1.x 升级」。
> 数字：引擎 107 项 + 适配层 30 项测试全绿；反幻觉基准 8/8 答对、编造率 0%。

### Fixed — R31 活体误覆盖：path-3 双口径门（建议 7 改法、建议 8 采纳）

- **机制**：contentText 余弦（含 detail 长文本主导）把两条可同时为真的记忆拉过 0.86，而 `oppositePolarity` 只看否定词形态、从不检验真矛盾。修复不是报告建议的 `||`→`&&`（那会连真否定一起杀：`cache holds no tokens` 无结构化主体，只能走极性臂；复发轮锁定的两个对照都会变红）——而是**第二口径**：开火前重测 summary-to-summary 余弦，也须过线（`claimThreshold` 默认 0.75，`diagnostics()` 可见； grounding：真否定 0.80/0.95，对题不兼容 0.00/0.6995）。
- **建议 8 落地**：override 警告印双口径（`content-sim X + claim-sim Y`）；content 过线而 claim 未过 → `new` + `withheld-contradiction:` 警告（印双值 + 如何强制），不再静默。
- **R30-6 落地**：`tags:["guard"]` 无对象、或对象无标签，写入期 `guard-note:` 警告（4/4 命中类问题当场暴露）。
- **仲裁确认**：旧记忆"0.783 触发、不要求实体重叠"系修复前（path-0 无实体闸）真实行为，现已过期——报告人 `retracts` 退休正确，`history` 留档；其阳性对照方法论（7/7 必须真触发，0/7 的 no 才有意义）记入探针纪律。

### Added — 抗幻觉：证据、撤回、前瞻（人脑机制对照建议 1–7，S5 本轮落地）

- **证据字段（S1）**：`remember` 接受 `verify{cmd,expect,artifact}` + `verify_result` + `verified_at`（engine 永不执行命令——agent 实跑后回填；新列含旧库 ALTER 迁移；`pass` 不带时间戳视为"刚跑过"自动盖章，显式旧戳保留年龄）。含数字主张句（箭头/系表）的 semantic 无 passing 证据 → 降级存为 episode（`downgraded:` 注记；R29 收窄：散文顺带数字如版本号不动）；注入渲染 `[VERIFIED]` / `[ASSERTED]`（`composeContext`；recall hits 透出证据字段）。
- **证据门 + 保鲜期（S2）**：新鲜 VERIFIED 现任只能被 passing 证据退休，否则挑战与现任并存 + `shielded:` 警告（显式 `supersedes` 仍可强制，意图明确者胜）；`evidenceTtlSec`（默认 30 天）过期的证明不再护盾、渲染回 `[ASSERTED]`，`verify()` 注记 `evidence is stale`——重跑刷新 `verifiedAt` 即续命。`verify()` 加扫版本历史：精确命中归档版（sim 1）+ 同主体换值模糊命中（复测余弦、有界 8 次嵌入）→ `superseded_matches` 增补 + `archived vN` 注记。洗白实验（真值 1.350565 → 编造 1.566）现两行并存，真值不退休。
- **撤回 tag 形态（S4）**：`tags:["retraction"]` + `retracts:<id>`（kind 三元不动）。撤回行永不被 override（亦不参与合并/被定为矛盾目标）；命中被撤回 id 的行带 `retracted{by,criterion}` + recall 小幅置顶；注入前缀 `[retracted: …]` 不可静默。
- **前瞻守卫 tag 形态（S6）**：`tags:["guard"]` + `guard{trigger,action}`（新列，喂给嵌入）；cue 命中触发词即召回 + 小幅置顶，注入标 `[GUARD]`。
- **值域先验（S3）**：`rangeCheck()` 纯函数（百分点越界、负熵、>1 的 0..1 比率、自带分子分母验算），warn-only 永不拦截，随各 outcome 注记返回。
- **低置信召回警告（元认知）**：`low`/`speculative` 且无 passing 证据的命中进 `warnings`（`low-confidence:` 点名 id），有证据的免检——"我以为"不再冒充"我知道"。
- **S7 三修一澄清 + cue 块数组修复（探针复测）**：首版 cue 解析仍假设 content 是字符串，实测真实形状是块数组（`[text]` / `[text,text]` / `[text,text,text]`），`typeof` 恒假 → 恒回空 → `reason=empty-cue`（对照 26/58 ≈ 抛硬币实锤）。现递归提文本（字符串/数组/嵌套对象，3 层封顶）+ title/goal 回退，`latestUserCue` 导出可测，三形状单测锁定。跟进三项：节点白名单（`source.plugin==='user'` 优先，prompt plumbing 永跳过，缺 source 退化到非注入节点）+ 交回 cue 前剥 digest 自环块 + 零命中渲染显式状态行（`[recent]` 只做 hits>0 的补充，不再静默兜底；旧"空必有物"测试已按新契约改写）。`[recent]` 死代码修复（push 时打标，实测可渲染）；`forget` 返回区分预览/执行（`wouldForget+note` vs `forgotten`）。双 surface 消息需 GUI 侧复现步骤，仓库侧无法验证。
- **图式压缩 S5（N→1+K，本轮落地）**：`proposeCompressions()` 只读提议同域 episode 组（含代表建议，跳过 retraction/guard/invariant）；`compress(plan)` 校验后落调用方起草的 invariant（semantic + `tag:invariant`，detail 具名全部成员），非代表成员 `demoted=1`（活行、版本历史不动，默认召回排除，`includeDemoted` 展开）。显式 plan 必需（无 plan 的 apply 直接报错）。`forget` 永不删折叠行；`undemote(ids)` 恢复。旧库 ALTER 迁移零成本。

### Added — 外部实测反馈三项 P0 修复

- **P0-1 verify 盲区**：`sourceMonitor` 不再只返回全局 argmax。新增四组证据字段：`contradicting[]`（同 scope 反极性行——先前否定行 cosine 低于肯定行时完全不可见）、`newer_related[]`（同 scope 更新的行——旧措辞赢得 argmax 但已被更新的结论取代）、`superseded_matches[]`（被显式 supersedes 边退役的行）、`stale_support`（顶部支持不是该 scope 最新结论）。note 同步携带 WARNING。
- **P0-2 remember 盲写**：`remember` 返回 `neighbours[]`（top-3 最近邻 + 相似度 + `suspectedConflict` 极性冲突标记——候选扫描本就计算这些相似度，回显零成本）与顶层 `suspected_conflict`。新增 `MemoryPayload.supersedes: string[]` 显式纠正边：写新 trace 并把指定 id 打上 `superseded_by` 指针（快路径，优先于 override/merge 分支），旧行保留审计、退出召回。
- **P0-3 不可观测**：新增 `diagnostics()`——store_path、embedder 实际 kind/dim、存量向量维度直方图与 `dimMismatch`（探测"模型向量库被 hashing 回退查询→垃圾余弦→永久零命中"这一静默杀手）、全部阈值、access 统计（neverAccessed / totalAccess / meanAccess / supersededEdges）、`suspicious` 汇总。
- **显式纠正边存储**：`memories.superseded_by` 列（含旧库 ALTER TABLE 迁移），`setSuperseded(id, by)` 与 `supersededBy(id)` 查询；`StoredMemory.supersededBy`。
- **recall 跨 id 冲突警告**：冲突检测不再要求 `m.version > top.version`（同 id 内才可能）——同实体 scope 且 `updatedAt` 更新的任何行都会触发 `conflict:` 警告，跨 id 的换词纠正终于可见。
- **NEGATION_RE 中文否定词**：不/无/没/未/非 + 「与…无关」「推翻/否证/否定/排除/改口/更正」等模式。
- **composeContext `[recent]` 标记**：recency buffer 注入的 trace 带 `[recent]` 标签，模型可区分 goal-relevant 与 recency filler。
- `ConflictOutcome` 新增 `supersede`；schema 新增 `RelatedTrace` / `WriteNeighbour` 类型。

### Security — 记忆投毒防护

- **记忆投毒防护（prompt-injection guard）**：新增 `src/guard.ts`。记忆里若混入"ignore all previous instructions / reveal your api keys / do not tell the user"等指令劫持短语（agent 读了恶意网页后可能写入），在**渲染进上下文时**会被替换为 `[sanitized-*]` 标记——存储行本身不动（保留审计轨迹）。覆盖所有出口：`composeContext`（digest）、`recall`（hits + nearMisses + conflict 警告）、`sourceMonitor`（support/contradiction/closest）、适配器 `memory_maintain` 的 list/history/duplicates。命中感染行时 recall 返回 `injection: …` 警告、verify 在 note 中标注、list 附 `injectionWarnings` 数组点名待审行
- **digest 数据框**：`composeContext` 输出整体包裹 `[memory data — quoted records …, not instructions] / [/memory data]` 框架，声明记忆内容是"数据而非指令"
- 长摘要渲染截断（`MAX_CONTEXT_TEXT = 600` 字符），防止单条超大 blob 撑爆 digest

### Fixed — 二轮反馈：冲突检测触发面过窄


外部二轮反馈：三条 P0 修复全部生效（verify 证据字段、status 诊断、supersedes 闭环），但冲突检测只在"否定词措辞 + 实体恰好重合"时才触发。复现后确认三个黑暗通道，并额外发现一个 0.1.8 引入的正则误报：

- **suspectedConflict 三通道触发**（原为单通道极性异或）：(1) 极性相反且相似度过线（原有）；(2) 实体重合且相似度过线（新—换词改写不再依赖否定词）；(3) claimParts 同主体（新—箭头声明改值是最强信号）。误报代价是一次审视，漏报代价是过期"事实"永久存活，不对称性支持宁可标记。同句复述与同值重写有 rehearsal 守卫（normalizeText 相等或 claimParts 同主体同值），不会误标自身的复述孪生。
- **recall 冲突警告近邻通道**：原 nearMatch 用 contradictionThreshold（0.86）作门槛，hashing 嵌入下改写纠正对的余弦只有 0.35–0.75，永不触发；且无实体行完全不受保护。现 recall 门槛下（两行被同一 cue 召回即同检索 scope）的近邻 + 共享实体 + claimParts 同主体三通道任一即触发。
- **NEGATION_RE 误报修复（0.1.8 引入）**：中文动词备选（排除/否定/更正）原为裸匹配，领域术语"硬排除集"里的"排除"会让**原事实**极性翻转—测试者的 suspected_conflict 正例实际是这个 bug 起的作用。现动词形要求后缀了/为/：/:（"排除了"匹配、"排除集"不匹配），单字否定表去掉"无"（由"与…无关"复合形覆盖），避免"无关的记录"误报。
- **rehearsal 早退补全**：remember 的两条复述路径（claimParts 同值、verbatim 复述）原返回不含 neighbours / suspected_conflict—写库后看不到"我旁边有什么"。现在与 supersede / override / new 路径一致回显。

### Fixed — 并发写与访问计数

- **共享库并发写**：SQLite 连接统一加 `PRAGMA busy_timeout = 5000`（`SqliteStore` 构造与懒打开落盘时都生效，可经 `busyTimeoutMs` 配置）。此前 `sharedStore: true` 下两个 agent 同时写会直接抛 `SQLITE_BUSY`

### Changed — 间隔重复与重要性

- **重要性激活（间隔重复）**：复述强化从恒 `+0.03` 改为按距上次访问间隔对数加权 `0.01 + 0.03·log2(1+间隔天数)`（上限 0.12）——集中重复几乎无增益、间隔重复增益大（Bjok 合意困难）。`recall` 命中也会小幅强化（boost × 0.5，提取练习/测试效应），并顺手修复了 touchAccess 后再 update 会回写旧 access_count 的顺序缺陷（现在一次 UPDATE 同时落 access_count / last_access_at / importance）
- **`memory_remember` 新增 `importance` 参数**（0..1）：显式传入优先于 confidence 推导；工具描述中给出建议档位（用户长期偏好 0.9+、项目关键事实 0.8+、琐碎观察 <0.4）。此前 167 行真实库全部 importance=0.70，重要性排序从未生效——现在 agent 可以表达"这条更重要"，且被频繁间隔召回的记忆自动升权
- 适配器对旧版 hippo-memory-core（0.1.6，无 guard 模块）保持兼容：guard 函数缺失时降级为恒等函数


### Fixed — diagnostics() 的死指标

- **ctivity.supersededEdges 恒为 0**：原实现在 llActive() 上统计 superseded_by，而带出边的行必然 superseded = 1，永远不在 active 集合里——该指标结构上不可能非零（实测库里有 1 条退役边却报 0）。改为 SqliteStore.countSupersededEdges() 直接对退役行计数。新增 follow-up E 回归测试。

### Changed — 代码审查（ponytail）：删死代码、接死配置、去重复扫描

- **`relatedTraces()` 死代码删除**：0.1.x 的 sourceMonitor 重写后把邻域扫描内联了，这个私有方法全仓零调用（24 行）。
- **`topK` 死配置接上**：schema 声明 + 默认 20 + README 示例都在，但 `options.topK` 从未被读取，recall 的候选重排实际无上限。按文档语义接入（仅当候选超过上限才排序截断，小库不做无谓排序）。
- **sourceMonitor 去掉重复扫描**：原来 argmax 一趟 `allActive()`、邻域扫描再一趟，并对同一 cue 向量重复计算每行余弦。改为一次打分复用（实测 400 行库 17.5ms → 8.8ms，约 2×）。
- 删除悬在 `polarityOf` 上方、与 `sourceMonitor` 自身 docblock 重复的错位注释块。
- 新增 `test/ponytail.test.mjs`：topK 确实截断（对比 capped/uncapped 才有效）+ sourceMonitor 单次 `allActive()`。

### Fixed — recall warnings 假冲突（三轮反馈 "狼来了"）

外部三轮反馈：`memory_recall` 的 `warnings` 把 25 条记忆全部列为冲突，包含刚写入的和明显不相干的（rt_host 日志、入口链实测、第八轮 RSP=4）——`scanned: 70` 而 warnings 里 25 条 ≈ 所有"有邻居"的记忆。没有冲突检测是漏报，**全是假冲突是狼来了**，调用方会学会直接忽略 warnings，比漏报更糟。

- **根因（本版引入的回归）**：recall 冲突判据里 `nearMatch = m.similarity >= options.similarityThreshold` **恒为真**——`hits` 本身就是按这个下限准入的，所以 OR 链退化成"比 top hit 更新即冲突"，把整个结果集报成冲突。
- **判据收紧为"scope-key 精确匹配 + 真实分歧"**：必须同时满足 (1) scope-key 匹配（共享实体 **且** 结构化主体相同，或实体集合完全相同）与 (2) 分歧（极性相反，或同主体绑定不同值——箭头式 `X -> a` vs `X -> b` 无需否定词即构成属性冲突）。**更新的时间戳本身不是冲突，只是同题兄弟。**
- **新增 `nearDuplicates` 字段**：非冲突的重叠行降级到这里（带 `reason: newer-sibling` / `older-sibling`），可见但不报警。core 与适配器 `memory_recall` 均已透出。
- 移除一个不可达分支：原先"live hit 是某条退役边的目标"也当冲突，但该 hit 是**更正者**（可信行），语义方向反了；且退役行本就不在 `hits` 里，该条件无法命中。

### Fixed — nearDuplicates 二次假阳性（同一 bug 换了字段）

外部四轮反馈：`nearDuplicates` 返回了几乎整个存储（70+ 条），全部标 `older-sibling`——把 warnings 的问题整体搬到了新字段。

- **根因**：`nearDuplicates` 是冲突检查的 `else` 分支，判据只有 `mRec.updatedAt !== top.updatedAt`（几乎每行都成立）+ `similarity >= similarityThreshold`（hits 已按下限准入，恒真）。**同一个"条件由检索结果派生"的错误，第二次犯。**
- **改用专用阈值与专用比较**：门限改为 `nearDuplicateThreshold`（0.92），且比较对象从 **cue** 改为 **top hit 行本身**——`mRec.similarity` 是 cosine-to-cue，衡量的是"两者都跟查询相关"（每个 hit 都成立，语义相反的近义词也一样），无法判断两行是否在说同一件事。实测 bge 下：仅差一个句号的两行 0.98（应报），换词改写 0.90（不该报），无关对 0.54。
- 重写伴随的旧测试：原先断言"同主题兄弟必须出现在 nearDuplicates"——正是被举报的行为；现断言"仅共享主题的两行两个字段都为空"。
- 新增 `test/selectivity.test.mjs`（3 用例）：30 条互异行 → nearDuplicates 为空；真近重复对 → 上报且是子集；通用守卫"nearDuplicates 必须 < hits/2"。

### Fixed — BUG-1：remember 静默覆盖无关记忆（真实事故）

外部五轮反馈（真实事故，非构造）：写入一条全新记忆（未传 `supersedes`）返回 `outcome: override`，静默退役了一条讲"硬排除集具体数值"的记忆，而写入内容讲的是"本轮 8 个错"——毫无关系。返回 `ok: true`，无警告，`superseded` 静静列在字段里。

三条根因（全部复现并修复）：

- **(a) override 分支 0 只按结构化主体键匹配，完全不看余弦**——所以文档声明的 0.86 阈值对它根本不适用（实测 0.783/0.843 即触发）。根子更深：`claimParts` 会从**普通散文**里抽出"主体"（`the meeting room booking is handled two days ahead` → 主体 `the meeting room booking`），于是共享名词短语的两句无关话就会撞键。
- **(b) 分支 3 的 scope 判据写作 `entities.length === 0 || closest.entities_json === '[]' || overlap`**——"未声明实体"被当作"共享 scope"，两条无实体行仅凭余弦即可互相覆盖。
- **(c) 覆盖只体现在返回的 `superseded` 字段**，容易漏看。

修复：**覆盖必须要求实体交集非空**（或显式传 `supersedes`，该快路径本就表达明确意图）；不满足时降级为新 trace 并把重叠行报告到新字段 `scope_only_matches`；所有 override 一律携带 `warning`（点名退役了什么、如何用 `memory_maintain history` 恢复、下次如何显式声明）。

已知取舍：不声明实体的行之间不再自动覆盖（代价是多存一行），旧行为代价是用户丢数据。高频领域词抬高任意两行相似度的问题由此消除。

### Added — `override-audit`：覆盖事故审计视图

`duplicates()` 只能发现**仍并存**的近同文本行（实测 7 组，全是 episode/semantic 同内容对），对危害最大的覆盖事故**完全看不见**——因为覆盖会把旧行归档，不留可比的活行。新增 `memory_maintain action: "override-audit"`：走版本历史，比对**绑定值**（而非整句——结构化声明的主体在更正中不变，整句重叠永远偏高），报告"归档文本与现行文本几乎不重叠"的行（`overlap` / 双方摘要 / 共享实体），供人工复核。只读，启发式筛选用途（低重叠是复核提示，不是判定）。实测在真实库上正确标出 3 行，含一行实体共享但值完全改变的情况。

### Verified — BUG-2 渲染损坏不在插件内

对含"非 ASCII + 反引号"的行做逐出口核对（`get` / `list` / `recall` / `composeContext`）：读回与原输入 **byte-identical 且 sha256 一致**，无反引号丢失、无 U+FFFD、无孤立代理项。插件不做 span 切片或字节/字符偏移换算，渲染层的伪影不经由本插件产生。

### Fixed — BUG-1 recurrence：cosine + 共享实体仍会误伤（同域术语）

外部六轮反馈：带实体交集守卫的新代码下仍连着两次覆盖。第一次是真冲突的反面教材——旧结论讲"第 0 字节"，新写入讲"第 2–5 字节"，余弦 0.88；第二次把核心结论 v2 推进归档。用户靠"换主语"绕开。

- **根因**：路径 3（cosine ≥ 0.86 + 实体交集 + 同事件窗口）里，余弦在共享领域术语的行之间天然偏高，不能作为"同一主张"的证据。0.880 / 0.863 开火、0.853 未开火的三行看似纯阈值，实为"阈值 + 实体交集"双条件（ kind 限制是结构性的：`closest` 只取同 kind 候选，episode 行永远够不着 semantic 写入）。
- **修复**：路径 3 追加分歧证据——要求**同结构化主体**（同一属性换值）或**极性相反**，否则降级为 new trace（neighbours 可见，可显式 supersede）。中性改写的纠正不再自动覆盖，这是刻意取舍：多存一行 vs 丢数据。
- **warning 标明开火路径**：两处 override 返回此前共用一句"matched on shared subject and entities"，路径 3 开火时这句是错的。现分别标注 `path-0 identical structured subject` 与 `path-3 cosine X.XX + ...`，满足"定位开火路径"的要求。
- **确认用户推断（6）**：`update()` 确实合并实体（payload 集合 ∪ 现有集合，`src/memory.ts` 合并逻辑），"一旦沾上 TBL，之后任何带 TBL 的写入都撞它"成立。但新门把危害收敛了：实体交集 alone 不再能开火，必须叠加同主体或反极性。是否把合并改为替换（history 保留审计）待定——改动存储语义，需单独确认。

### Tests
- 新增 BUG-1 recurrence 用例 2 则：共享实体 + 高余弦但主体不同/极性相同 → 必须 `new`；共享实体 + 反极性 → 仍 `override` 且 warning 含 `path-3`。

### Tests
- 新增 `test/bug1-override.test.mjs`（5 用例）：同主体键无共享实体不覆盖、不相交实体不覆盖、真实同 scope 更正确仍覆盖且带 warning、无实体行不再互相覆盖、显式 supersedes 仍生效。
- 新增 `test/override-audit.test.mjs`（2 用例）：主体改变被标出、正常更正不误报、只读不改动。
- 适配器：`remember` 透出 `warning` 与 `scope_only_matches`；override 测试改为声明共享实体（与"必须有 scope"的新契约一致），并新增"未声明 scope 不得覆盖"用例。

### Tests
- 修正两条**编码了该 bug 的旧测试**（`recall: cross-id newer trace…`、`follow-up D` 断言"同主题两行必报冲突"——正是被举报的行为）。改为：同主题兄弟 → 0 冲突 + 出现在 `nearDuplicates`；真实 scope-key 分歧 → 报冲突且只点名分歧行；20 条兄弟行 → 0 冲突（现场回归的缩微复现）。

### Tests

- `test/p0-regressions.test.mjs` 新增 follow-up A / A2 / B / C / D 五用例：否定+实体（测试者路径）、领域术语不翻极性（rehearsal 守卫）、不同主体保持安静、实体通道、recall 无实体警告。76/76 全绿，适配器 22/22 不受影响。

### Compatibility

- 既有库零迁移成本：`superseded_by` 为可空列，旧行为不变；不带 `supersedes` 的 remember 行为与 0.1.7 完全一致。
- 新测试：`test/p0-regressions.test.mjs`（10 用例，全部复现自反馈报告场景）。

### Fixed — 实测四项反馈（BUG-A/B/C/D）

- **BUG-A merge 路径文档与实现不一致**：`merge` 真实存在但触发面极窄——仅当 episode 逐字复述 semantic 规则（剥离 `FACT: ` 前缀后正文完全相同、episode→semantic、余弦 ≥ nearDuplicateThreshold）时开火，同 kind 复述走 rehearsal（`none`）、同主体换值走 override。9 次探针全是同 kind 写入，所以一次也没见到它是符合设计的。修复为文档而非行为：代码注释、README outcome 枚举（含既往遗漏的 `supersede`）与工具描述如实写明触发条件；`merge` 返回补齐 `neighbours` / `scope_only_matches` / `suspected_conflict`，与其他分支一致可观测。覆盖语义、版本归档均未动。
- **BUG-B 同 summary 不同 detail 被静默丢弃**：两条复述路径（verbatim `isRetell`、path-0 同值）只比 summary，不看 detail——写 2 直接 `none`，BETA detail 无落盘、无 warning。现两处复述都要求 detail（去首尾空白后）相等，否则落到正常管线（一般为 `new`，两行并存）。另：engine recall 命中本就含 `detail`，但适配器 `memory_recall` hits / `memory_maintain` list / history 在映射时剥掉了它，造成"写入可存、读取无门"。现适配器透出 `detail`（recall hits、verify support/contradiction/closest/contradicting、list、history），外加 recall hits 与 list 的 `entities` / `tags`。只增字段，不改形状。
- **BUG-C verify 在证据不足时编造"矛盾"**：`contradicting[]` 判据是"related 行中极性不同"，而 related 门槛只是 `sim ≥ similarityThreshold（0.32）或实体重叠`——生产嵌入下任何 0.55 的无关否定句都会被标 `assert the OPPOSITE`。现要求同 scope-key（与支撑行共享实体，或与支撑/claim 同结构化主体）**且**真实分歧（极性相反或同主体不同值），否则不进 `contradicting[]`、不写 OPPOSITE 警告（第八轮进一步收紧为必须共享实体，见下）。措辞保留（命中时即为真凭实据）。
- **BUG-D `scope_only_matches` 命名误导**：字段本意是"同主体键、被实体闸门挡下的行"，非常名；但它是已发布 API，不改名。改为三处对齐：注释与工具描述写明"空数组 = 无可报告，非未检查"；此前 `supersede` / 复述 `none` / `merge` 分支根本不返回该字段（调用方只能看到 `[]` 兜底），现所有 outcome 一律显式返回。

### Fixed — 实测第八轮反馈（★ + 5 条建议）

- **★ 无实体写入的覆盖机制失效（误报撤回 + 静默修复）**：报告人复核源码后撤回——"无实体时互相不覆盖"是 BUG-1 (b) 的刻意设计，不是缺陷；按撤回意见，已落子的 path-0b fallback（两侧无实体箭头翻转走覆盖）同步撤销，实体闸门恢复严格形态。保留且有价值的是"静默"部分：`new` 且 `scope_only_matches` 非空时携带 `not-overridden:` 警告（点名被挡的行 + 如何授权：声明其实体或传 `supersedes:[id]`），"看得见却不用"到此结束。
- **G5 merge 未触发（真问题，已修）**：直驱探针复现——episode 逐字重述 semantic 得 `new`。根因是 merge 分支的余弦闸（`sim ≥ 0.92`）：`contentText` 含 detail/规则/实体等元数据，逐字相同的正文也可能被元数据余弦拖过线（`FACT: ` 包装、detail 差异同理），分支是否开火取决于 embedder 而非文本同一性。修复：去余弦闸，改精确同一门——剥离包装后正文 + 逐字 detail + 实体集合三者全等才 merge（三者任一不同即 episode 自带信息，留独立行，与 BUG-B 同理）。分支因此跨 embedder 确定。
- **直驱 entities 形状容错**：engine 要求 `{name}` 对象数组（适配层负责转换），直驱传字符串数组直接 TypeError。`entityNames` 现与 `update()` 一致接受两种形状（文档契约仍是对象数组）。
- **③ verify `contradicting[]` 二次收紧**：验证已归档旧值时，实体不相交的无关行仍被标 OPPOSITE（0.6+ sim）。剩余漏向量是"散文同主体"（claimParts 从普通散文抽主体，本是 BUG-1 (a) 的根子）。现 `contradicting[]` 要求**与支撑行共享实体**（放掉"同主体即可"），再叠加真实分歧（极性相反或同主体不同值）——即"同 scope 且文本确实相反"，与建议一致。同 scope 真反例（共享实体 + 否定）仍上报，措辞保留。
- **① merge（文档定案）**：`merge` 可达且被测试锁定（episode 逐字复述 semantic 规则 → `merge`），同 kind 无第三种形状可分（复述=`none`、换值=`override`），故不新增同 kind 合并（那会复制这两条语义）；README 增"何时开火"小节。警告文案核对过：没有任何 warning 提及 merge（`or pass supersedes` 出自 override，与 merge 无关），无需删词。
- **② 旧值召回（文档定案）**：召回/验证只看现行版是版本语义本身（禁改区），不动。`history` 现含 `detail` + `entities`（engine + 适配器已透出），README 增"旧值去哪了"小节（`version>1` → `history <id>`；`newer_related`/`stale_support` 提示过期支持）。
- **④ 命名（文档定案）**：已发布 API 不改名；README 增"读法"小节 + 工具描述已写明含义。`reason` 字段（`same-subject-key, no shared entity`）即释义本体。
- **⑤ 多行选择（文档定案）**：README 增"同主体多行怎么选"（`updatedAt`/`version` 定现行，`relativeScore` 只定 cue 贴合，`detail`+`history` 定时间点答案；更新时声明实体或传 `supersedes`）。

### Docs — G5f 复述格说明（探针观察，无行为变更）

- 同 kind 逐字重述得 `none` 且 `version` 不增是强化语义（重要性/访问计数照常更新），不是丢失：行数判据请用 `outcome`（仅 `new` 多一行）。常规成功路径故意不配 `warning`（狼来了教训）。README"何时开火"小节增 G5f 条目；`merge` 条目同步新精确同一门（去余弦闸）。

## [0.1.6] — 2026-09-12

### Added
- 召回可解释性：`recall()` 现在返回 `reason` / `eligible` / `bestSimilarity` / `threshold` / `nearMisses`，空结果不再是一个无法解释的空数组（`reason` 区分 `below-threshold`（有相关记忆但都没过门槛）与 `no-candidates`（库里没有或全被筛掉））
- 分数口径透明：命中同时给出 `similarity`（**原始余弦**，与 `similarityThreshold`、与 `sourceMonitor` 同口径）、`score`（含重要性加权 `sim × (0.6 + 0.4·importance)`，上限 1.0）、`relativeScore`（本次查询内相对分，1.0 = 最佳）。此前只给 `score`，导致 "verify 0.604 / recall 0.449" 这类看似矛盾的数字
- 标识符精确命中：query 与记忆共享 `0x…` / `D-387` / commit sha / 版本号等 token 时，即使余弦低于门槛也召回，命中标 `literalMatch`（共享 token 数）并获排序加成。实测生产库 277 条标识符查询 Top-1 命中率 10.5% → 99.6%，MRR 0.195 → 0.998
- `duplicates()`：只读报告近似重复记忆（跨 kind 比对，忽略 `FACT: ` 前缀与大小写/标点差异），不删除任何数据
- `remember()` 覆盖时返回 `superseded`（被替换的 id / 版本 / 摘要 / 恢复方式），版本化覆盖不再静默
- `pruneEmptyStores(dir, opts)`：清理不含任何记忆与历史的空库文件（跳过锁定/新写入的文件，永不删除有数据的库）
- `HippoMemory({ createFile: false })` 与 `SqliteStore(path, { create: false })`：懒打开——文件不存在的库驻留内存，只在首次写入时落地
- `SqliteStore.isEmpty()`：判断库是否无记忆且无历史

### Fixed
- **跨类型合并漏判**：consolidate 把 episode 抽象成规则时写入 `FACT: <原文>`，而合并比对未剥离该前缀，导致同一事实的 episode 与 semantic 规则长期并存（实测生产库 17 对重复）。现比对前统一剥离 `FACT: ` 前缀，重述会正确并入原记忆
- 只读访问（digest 渲染、recall、list）不再为每个 agent 创建空库文件

## [0.1.5] — 2026-09-07

### Changed
- 文档同步（README 迁移 API 说明）；CHANGELOG 纳入 npm 包 files

## [0.1.4] — 2026-09-07

### Added
- `recall()` 空 cue 兜底：无查询词时返回最近更新记忆（自动摘要永不空白）
- `HippoMemory.delete(id)`：按 id 永久删除记忆（含全部版本历史），不存在则抛错

## [0.1.3] — 2026-09-07

### Added
- `ensureEmbeddingMigration()`：把哈希嵌入的历史记忆一次性迁移到当前嵌入模型（PRAGMA user_version 持久标记，仅跑一次）；空库直接标记完成
- 引擎测试 +2（迁移幂等、空库），共 21 项引擎测试

### Fixed
- 无（引擎行为不变，新增迁移 API）

## [0.1.2] — 2026-09-07

### Added
- `sourceMonitor` 未命中时返回 `closest`（最接近的候选），verify 结果可解释
- 引擎新增 `list(limit)` 库存 API（最新优先），adapter `memory_maintain` 增加 `list` action
- 适配器测试套件（`packages/dsh-hippo-memory/test`，9 项）：工具注册、schema 形状、写→查→验证语义、共享/隔离存储
- GitHub CI（build + 28 tests + bench smoke + 语法检查）、英文 README、ROADMAP、issue 模板

### Changed
- 根 `npm test` 现在同时跑引擎与适配器测试（28 项）

## [0.1.1] — 2026-09-07

### Changed
- 补充 `keywords`（dsh / deepseek-runtime / long-term-memory / embedding 等）提升 npm 可发现性
- package.json 增加 `repository` / `homepage`（指向公开 GitHub 仓库）

## [0.1.0] — 2026-09-07

首个发布版本（曾用名 `hippo-memory`，该名已被占用，改用 `hippo-memory-core`）。

### Added
- 受海马体机制启发的长时记忆引擎（框架无关）：
  - 稀疏编码 + 模式分离（DG/CA3 类比），线索驱动召回
  - 写入冲突处理：同主体新值 → 版本化覆盖（旧值进 `history`），1h 同事件窗口合并
  - 源监控（`sourceMonitor`）：SUBSTANTIATED / CONTRADICTED / UNSUBSTANTIATED 三态裁决 + 否定句启发
  - 系统巩固（`consolidate`）：高频 episode → semantic 规则
  - 自适应遗忘（`forget`）：弱痕迹衰减，dry-run 预览
  - 零外部服务：Node 内置 `node:sqlite` + 进程内 512 维 FNV 哈希嵌入（可选接真嵌入模型 `setEmbedder`）
- 反幻觉评测基准（`npm run bench`）：长会话对比 无记忆 0/8 vs 有记忆 8/8 正确
- 单元测试 19 项（node:test）

### Fixed
- 相似度阈值 0.4 → 0.32：离线哈希嵌入对短语/中文查询的绝对余弦偏低，0.4 会误杀真实命中（实测同主题中文查询 0.39 被拦）

### Notes
- 引擎不绑定任何 agent 框架；DSH 用户请安装 `dsh-hippo-memory`（适配层）
- Node ≥ 22.5（需要内置 `node:sqlite` / `node:zlib` zstd）
