# Changelog

## [0.1.8] — 2026-09-12

### Added
- `memory_recall` 可解释性：返回 `reason` / `eligible` / `bestSimilarity` / `threshold` / `nearMisses`，空结果会说明原因（`below-threshold` 有相关记忆但没过门槛 vs `no-candidates` 库里没有或全被筛掉），不再只给一个空数组
- `memory_recall` 每个命中给出三个分数：`similarity`（原始余弦，与 `threshold`、与 `memory_verify` 同口径，可直接比较）、`score`（含重要性加权 sim × (0.6 + 0.4·importance)，上限 1.0）、`relativeScore`（本次查询内相对分，1.0 = 本次最佳）；`literalMatch` 标记标识符（0x… / D-387 / commit sha）精确命中数
- `memory_recall` 默认条数 5 → 8（上限 10 → 20）
- `memory_remember` 覆盖时返回 `superseded`（被替换的 id / 版本 / 摘要 + 恢复方式），版本化覆盖不再静默
- `memory_maintain duplicates`：只读报告近似重复记忆（跨 kind 比对，自动忽略 `FACT: `前缀与大小写/标点差异），确认后再用 `delete` 清理

### Changed
- 依赖 `hippo-memory-core` 收紧为 `^0.1.6`（新字段与新动作依赖该版本；此前 `^0.1.0` 会允许装上缺这些 API 的旧核心）

### Fixed
- 相同事实的 episode 与 `FACT: `规则不再并存（引擎侧合并漏判已修，见 core 0.1.6）

## [0.1.7] — 2026-09-10

### Added
- `memory_maintain prune`：清理空库文件（返回清理数量与文件名）
- 启动后台自动清理空库（延迟 5 秒、完全兜底，不影响启动）

### Fixed
- 存储目录不再堆积空库文件：库改为按需创建——只读访问驻留内存，首次写入才生成 `.db`
- 说明：此前每渲染一次 digest、每调用一次 recall/list 都会为对应 agent 建一个库文件（实测一天新增 35 个，其中 24 个为空）

## [0.1.6] — 2026-09-07

### Changed
- 启动懒加载：模型预热移出启动路径（`dsh web` 提速、GLib 噪音推迟到首次对话）；digest 首轮渲染触发加载
- digest 空白修复：同 cue 空结果允许重查；无结果时显示记忆数 fallback（永不空白）；命中时附收尾自提醒
- 读取保障：recall/verify 先确保模型 ready（超时回退哈希），不再静默空结果

### Added
- `memory_maintain delete`：按 id 永久删除记忆

## [0.1.5] — 2026-09-07

### Changed
- GUI 提示文案模型体积修正（~100MB → ~24MB 量化版，双语）；README 同步迁移与 status 说明

## [0.1.4] — 2026-09-07

### Fixed
- **嵌入向量维度解析 bug**：transformers.js 返回单一 Tensor（`dims=[batch,512]`），旧实现把整块 buffer 当一条向量（多文本批量时误判为高维、迁移错乱）；现按 batch 正确切分，维度从 probe 动态探测
- 嵌入模型迁移接入 `ensureEmbeddingMigration()`（引擎 0.1.3）：开启 auto 后旧哈希记忆一次性自动重嵌入（持久标记，仅一次）；storeFor 新建实例同样触发

### Added
- 模型加载可见性：开始下载/成功（含维度与耗时）/失败均有明确日志；加载中 digest 块附带状态提示；`memory_maintain status` 返回 embedder 状态
- 适配器测试 +1（status），共 10 项

## [0.1.3] — 2026-09-07

### Changed
- 声明 `@xenova/transformers` 为 optionalDependency（保证 `embedding: auto` 在 npm 安装后可用；不可用时优雅回退哈希）

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
