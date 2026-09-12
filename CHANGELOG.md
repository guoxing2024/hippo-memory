# Changelog

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
