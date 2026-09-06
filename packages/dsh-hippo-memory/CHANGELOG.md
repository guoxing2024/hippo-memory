# Changelog

## [0.1.2] — 2026-09-07

### Added
- 设置项 **嵌入模型**（`embedding: off|auto`）：auto = 懒加载本地 bge-small-zh-v1.5，加载失败自动回退哈希
- 设置项 **召回阈值**（`similarityThreshold` 0.05–0.95，留空用引擎默认）
- `memory_verify` 返回 `closest`（未命中时给出最接近候选，可解释）
- `memory_maintain` 新增 `list` action（最新优先的库存浏览）
- GUI 卡片新增"嵌入模型"下拉与"召回阈值"输入（中英双语）
- 适配器测试套件（9 项，fake ctx 单测工具注册/schema/语义/隔离）

### Fixed
- settings 使用 schemastery 方言（`z.union` / `.required(false)`）

## [0.1.1] — 2026-09-07

### Changed
- 补充 `keywords`（dsh / deepseek-runtime / long-term-memory 等）提升 npm 可发现性
- package.json 增加 `repository` / `homepage`（指向公开 GitHub 仓库）

## [0.1.0] — 2026-09-07

首个发布版本。DSH 记忆插件（web profile bundle 双半侧）。

### Added
- **Host 半侧**（`lib/index.js`）：注册 4 个记忆工具（`memory_remember` / `memory_recall` / `memory_verify` / `memory_maintain`）、使用纪律提示词段、每轮自动摘要注入（`[hippo-memory digest]`，1.5s 节流缓存）、`hippo-memory` settings 命名空间（enabled / contextLimit / sharedStore）
- **Browser 半侧**（`lib/client.js`）：设置页"插件配置"手风琴卡片（启用开关 + 上下文条数 + 共享存储 + 放弃/保存），样式与内置卡片一致（`--dsw-alias-*` 主题变量）
- **GUI 开关即时生效**：停用即卸载工具/纪律/摘要，启用即恢复；记忆数据保留
- 每会话独立 SQLite 记忆库（`~/.dsh/storages/hippo-memory/session-<id>.db`），可选共享存储

### Fixed
- 工具返回经 lossless-JSON 清洗（`cleanJson`），杜绝 SQLite 空列（`undefined`）导致的 `value is not lossless JSON` 报错
- 记忆召回相似度阈值由引擎侧调低（0.4 → 0.32，见 `hippo-memory-core` 0.1.0），中文/短语查询命中率提升

### Notes
- 核心引擎为独立包 [`hippo-memory-core`](https://www.npmjs.com/package/hippo-memory-core)
- 需要 dsh ≥ 0.1.1-rc.1（`engines.dsh`）
