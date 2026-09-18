# Changelog

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
