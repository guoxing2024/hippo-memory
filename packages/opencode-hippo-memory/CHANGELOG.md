# Changelog

## [0.3.0] — 2026-09-20（需要引擎 `hippo-memory-core@^0.3.0`）

### Added

- **`memory_remember` 新增 `scope` 参数**（`key=value; key=value`）：声明这条结论在什么条件下成立。响应回显 `scope`；前提与存量行对不上时新写**不覆盖旧行**，两条并存并带 `different-scope:` 警告。
- **`memory_verify` 新增 `scope` 参数与 `out_of_scope` 返回**：库里那条是在别的前提下说的 → 答 `OUT_OF_SCOPE`（`substantiated` / `contradicted` 双假），不再把旧前提下的结论盖到当前问题上。支持行带前提而提问没给 scope 时，note 里出现 `CONDITIONAL SCOPE`。
- **`memory_recall` 命中带 `scope`**（`hitView` 透出），同一主题多个前提各一行时可分辨。
- **注入的使用纪律更新**：写入一条要求"只在条件下成立就带 `scope`"；查证一条要求"`out_of_scope` 说明记忆里的答案属于别的前提，不得搬用"。

> 依赖引擎带 `scope` 的新版本，下限已提到 `hippo-memory-core@^0.3.0`（带 `scope` 与 fuzzy 归档修复）。配旧引擎不报错：`scope` 被忽略、`out_of_scope` 恒为 `false`。

### Fixed — 第九轮实测反馈：适配层两处透传缺口（与 DSH 同构）

- **`memory_recall` 补 `scope` 参数并透传引擎**：此前 recall 工具**根本没有 `scope` 入参**，传给 `store.recall` 的 cue 也不含它——前提硬过滤在工具面完全不生效。现在加 `scope` 入参、透传给 cue，返回补 `scopeExcluded`（`?? null` 规范空值），description 补一句"问题带前提就传 scope"。
- **`memory_remember` 回显 `verify_result` / `verified_at`**：原样复述并带新证据时，证据落到存储行但返回对象不透出，调用方看不到复述是否带上了证据。现补齐两字段。
- 均为适配层透传修复；`sourceMonitor` 的 fuzzy 归档误报订正在 `hippo-memory-core`（见根 CHANGELOG）。本包与 DSH 适配层为结构同构改动。

### Added — ② 重复合并：`memory_maintain merge` / `undemote`

- **新增 `merge` 动作**：`{ action: "merge", ids: [一个 duplicates 组的 id] }`，**默认预览**（`dry_run !== false`），`dry_run: false` 才落地。返回 `survivor` / `retired[]` / `carried[]` / `blocked[]` / `note`，全部文本过引擎 `sanitizeMemoryText`（引擎抛回的拒绝理由也清洗——理由里有记忆原文）。
- **补上 `undemote` 动作**：此前提示语承诺"折叠可回滚"，但 opencode 侧根本没有恢复入口，承诺是假的。现在 `{ action: "undemote", ids: [...] }` 直接透传引擎的 `{ restored[] }`。
- **`duplicates` 报告变宽并清洗**：每行带 `scope`，组级带 `mixedPremises`（组里至少有一对行前提互斥即为 true）。提示语据此写明"这类组里与幸存行前提相符的行照常折叠，冲突的行留在 `blocked[]`"。
- **`merge` 是折叠不是删除**：多余行仍在库里、默认召回不出现、`list` 仍列出（引擎 `StoredMemory.demoted` 原样透出）。DSH 版 `list` 这次补了 `demoted` 字段，本包因为直接返回引擎对象所以本来就有。

### Added — ③ digest 门槛没过时不再空白

零命中 digest 现在可能带第 1 行 `[low-confidence sim 0.31 < floor 0.32: the closest trace, not a memory — verify before asserting]`（引擎产出，适配层不额外渲染）；同时零命中不再回填 `[recent]` 近况。**`DISCIPLINE` 补一句解释这行是什么**（门槛以下的猜测、不是记忆、不得当作已存事实复述），否则模型会把它当成过了门槛的证据引用。

### Added — ④ `status` 看得见隔壁那个库

- **新增 `path_rule`**：说明本项目的库文件名怎么来的（按项目目录 slug 分库；`sharedStore: true` 时所有项目写同一个 `shared.db`）。
- **`diagnostics` 整体透出**：`sibling_stores`（缓存目录里每个 `.db` 的 `rows` / `demoted` / `lastWrite` / `current`）、`scope_rule`、`coverage` 直接可在 `status` 里读到。
- **`health` 先判"本库空、隔壁满"**：这种情形说的是"这条记忆写在另一个库里"并提示 `sharedStore`，而不是原先那句嵌入器不匹配——opencode 按项目分库，过去这两种故障输出同形。

### Changed — 注入的使用纪律

`DISCIPLINE` 第 4 条（MAINTAIN）现在点名 `status` / `duplicates` / `merge` / `undemote`，并写明"`delete` 会连版本历史一起删，清重复该用 `merge`"。纪律里不提的工具模型不会想到去用，所以这一段是 `merge` 在 opencode 里真正可达的前提。新增测试断言这段文案包含 `merge` 与 `low-confidence`。

## [0.2.2] — 2026-09-18

### Fixed

- `@opencode-ai/plugin` 从 *optional peerDependency* 改成普通 **dependency**。
  之前 opencode 用 Arborist 把插件装进 `~/.cache/opencode/packages/<spec>/node_modules/` 时，
  **optional peer 不会被安装** → 插件里 `import('@opencode-ai/plugin')` 失败 → `tool()` 拿不到 →
  4 个 `memory_*` 工具的参数 schema 退化成空对象，模型收不到任何字段定义（工具看起来"在"但不可用）。
- SDK 缺失时不再静默降级：通过宿主 logger 打一条 `WARN @opencode-ai/plugin is not resolvable…`。

### Verified

- 装上真实 `@opencode-ai/plugin@1.18.31` 后：`memory_remember.args.*` 带真实 `~standard`（zod）schema，
  `execute()` 写入返回 `outcome:"new"`，6 个钩子齐全；适配层 12 项测试在"有 SDK / 无 SDK"两条路径下都通过。

## [0.2.1] — 2026-09-18

### Changed

- 版本号与 `hippo-memory-core` / `dsh-hippo-memory` 对齐到同一条发布线（0.2.1），首次发布到 npm。

### Fixed（文档）

- 安装说明补充：opencode 对 `plugin` 数组里的**纯包名**会去 npm registry 现装到 `~/.cache/opencode/packages/<spec>/node_modules/<name>`，
  **不会**读 `~/.config/opencode/node_modules`。所以在配置目录里手工 `npm install` 一个未发布的包，插件会被静默丢弃：
  安装失败只发一条 Bus error 事件（TUI 一次性提示），日志文件里没有任何记录（服务端 report 的 `missing` 回调是空函数）。
  包发布到 npm 之后，`opencode plugin -g opencode-hippo-memory` 才是可用路径。
- 数据位置说明：store 根目录是**按环境**决定的 —— `XDG_CACHE_HOME` 优先，Windows 走 `%LOCALAPPDATA%\opencode\hippo-memory`，
  其余平台走 `~/.cache/opencode/hippo-memory`。同一项目在 Windows 与其它平台落在不同文件，跨平台迁移需自行拷贝 `.db`。

## [0.2.0] — 2026-09-18

### Added

- 首个版本：opencode 适配层。
  - 4 个记忆工具：`memory_remember` / `memory_recall` / `memory_verify` / `memory_maintain`（9 个维护动作）
  - 每轮 digest 注入：优先 `experimental.chat.system.transform`，并带 `experimental.chat.messages.transform` 回退（用一个能力标志保证**同一轮只注入一次**）
  - 压缩保留：`experimental.session.compacting` 追加 "Durable memory" 块
  - 使用纪律小节 + `tool.execute.after` / `event` 轻量可观测性
  - 选项：`enabled` / `contextLimit` / `sharedStore` / `discipline` / `similarityThreshold`
  - 每项目一个 store，store 按目录缓存（路径见 0.2.1 的环境说明）
- 依赖 `hippo-memory-core` ^0.2.1（该版本起 SQLite 驱动在运行时探测，Bun 上自动用 `bun:sqlite`）。

### Notes

- 任何钩子里的异常都被吞掉并记录，**插件永远不会弄坏用户会话**。
- 12 项适配层测试（Node 直接驱动插件对象）。
- 0.2.0 时"真实 opencode 端到端验证"的说法只对**插件对象本身**成立（用 `.opencode/plugins/*.js` 直接 import dist 跑通：
  4 个工具注册、`system` 注入 digest 与纪律、压缩上下文附带）。以**包名**从全局配置加载那条路径当时并未真正跑通，
  原因见上面的安装说明——发布 0.2.1 后需要重新以包名验证一次。
