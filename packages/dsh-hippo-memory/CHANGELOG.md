# Changelog

## [Unreleased] — 需要引擎支持 `scope`（版本号待定）

### Added — 前提作用域透传到工具面

- **`memory_remember` 新增 `scope` 参数**：`key=value; key=value` 形式声明这条结论在什么条件下成立（`population=…` / `comparator=…` / `release=…`）。响应回显 `scope`（未写为 `null`）；前提与更近的存量行对不上时**不会覆盖它**，各存一条并带 `different-scope:` 警告。
- **`memory_verify` 新增 `scope` 参数 + `out_of_scope` 返回**：带着前提去问，库里属于别的前提的那条会答 `OUT_OF_SCOPE`（`substantiated` 与 `contradicted` 都为 `false`）而不是被盖章支持；支持行带前提而提问没给时，note 出现 `CONDITIONAL SCOPE` 并说明该前提未被核对。工具描述里补上了这第四种结局。
- **`memory_recall` 命中带 `scope`**：同一主题在不同前提下各有一行时，靠这个字段分辨 agent 看到的是哪一条。
- **`memory_maintain list` / `history` 透出 `scope`**（与其它文本同样过注入清洗），审查"这条是在什么口径下测的"不用回到对话里翻。
- **注入的记忆纪律更新**：第 1 条要求"只在条件下成立的结论要带 `scope`"，第 3 条要求"带 scope 去 verify，`out_of_scope` 时不得把那个答案搬到当前前提下"。

> `scope` / `out_of_scope` 依赖引擎带该字段的新版本。配旧引擎不会报错：`scope` 被忽略、`out_of_scope` 恒为 `false`，其余行为与本版之前一致。**发布时需把 `hippo-memory-core` 的依赖下限提到带 `scope` 的版本**（当前为 `^0.2.0`）。

### Added — ② 重复可以合并：`memory_maintain merge`

- **`memory_maintain` 从 12 个动作变 13 个**：新增 `merge`。`{ action: "merge", ids: [一个 duplicates 组的 id] }` 默认**预览**（`dry_run` 未给即为 true，返回谁留下、谁被折、`carried[]` 结转了什么、`blocked[]` 因何不动），`dry_run: false` 才落地。参数表补 `into`（点名要留的 id，必须是 `ids` 之一）与 `dry_run` 说明。
- **为什么不该再用 `delete` 清重复**：`delete` 连版本历史一起消失，`merge` 只把多余行折叠（`demoted`）——行还在库里、默认召回不再出现、`undemote` 随时恢复。`duplicates` 的提示语现在把这条路写清楚（"review, then merge a group you confirmed… or remove ids with action delete (history is removed with the row)"）。
- **`duplicates` 报告变宽**：每行带 `scope`，组级带 `mixedPremises`（组里至少有一对行前提互斥即为 true）。提示语据此写明：这类组**不是整组作废**，与幸存行前提相符的行照常折叠，冲突的行留在 `blocked[]`。
- **`list` 新增 `demoted` 字段**：合并 / 压缩过的行本来就一直出现在清单里，但此前没有任何标记，agent 分不清哪条是被折的、也就拿不到 `undemote` 要用的 id。现在每行带 `demoted: true/false`。

### Added — ③ 门槛没过时 digest 不再空白（本适配层无代码改动）

召回全部低于门槛时，digest 第 1 行是引擎给的最接近痕迹并带 `[low-confidence sim … < floor …: the closest trace, not a memory — verify before asserting]`；零命中时不再回填 `[recent]` 近况。适配层的渲染不变（digest 整体来自引擎），但**使用纪律补了一句解释**：见下面的 GUIDANCE 变更。

### Added — ④ `status` 看得见隔壁那个库

- **`status` 新增 `path_rule`**：一句"本宿主的库文件名是怎么来的"——开 `sharedStore` 时说明所有 agent 共用一个文件，否则说明"每个 agent id 一个文件，别的 agent 记的东西在这里看不到（要合并请开 sharedStore）"。
- **`diagnostics` 整体透出**，因此引擎新增的 `sibling_stores`（同目录每个 `.db` 的 `rows` / `demoted` / `lastWrite` / `current`）、`scope_rule`（"记忆不跨库文件流动"这条契约）与 `coverage`（本进程 digest 的 `turns` / `misses` / `guesses`）在 `status` 里直接可读，不需要改渲染层。
- **`health` 判定顺序改为"先看库分裂"**：本库 0 行而隔壁有货 → 直接说"这条记忆写在另一个库里"（点名 agent 维度），其次才是嵌入器不匹配。DSH 按 agent id 分库，所以"没记住"与"记在另一个文件"在工具输出里过去完全同形。

### Changed — 注入的使用纪律（模型能不能看见这些能力）

- `GUIDANCE` 第 4 条（MAINTAIN）现在**点名** `status` / `duplicates` / `merge` / `undemote`，并写明 `mixedPremises` 组的读法和"`delete` 会连版本历史一起删"。一条工具如果纪律里不提，模型基本不会想到去用——这是本批唯一让 `merge` 真正可达的改动。
- `GUIDANCE` 第 5 条补一句：digest 里 `[low-confidence …]` 那行是**门槛以下的猜测**，不是记忆，断言前须复查、不得当成已存事实复述。
- 新增测试锁住这段文案（纪律里必须出现 `duplicates` / `merge` / `low-confidence`），避免以后改提示词时把可达性悄悄改掉。

## [0.2.1] — 2026-09-18

### Fixed

- 包内 README 的完整使用说明链接改为 GitHub 绝对地址（npm 页面上的相对路径 `../../docs/…` 无法解析）。仅文档变更，无代码差异。

## [0.2.0] — 2026-09-18

> **大版本：适配层与引擎 0.2.0 同步。** 新增证据 / 撤回 / 前瞻 / 显式纠正边参数，新增 `memory_maintain compress|undemote|override-audit` 动作与 `status` 深度诊断，渲染出口统一清洗 + 数据框架。
> 升级：`dsh plugin --profile <profile> update dsh-hippo-memory` 后重启 profile；旧记忆库无需迁移，对旧引擎自动降级兼容。

### Added — 外部实测反馈三项 P0 修复

- **`memory_verify` 证据字段**：返回 `contradicting[]` / `newer_related[]` / `superseded_matches[]` / `stale_support`——先前只有 argmax 单行结论，同 scope 的反极性行、更新的换词结论、被显式退役的行全部不可见（实测：旧措辞赢 cosine 0.94，真正的最新结论 0.60，永远看不到）。
- **`memory_remember` 新增 `supersedes` 参数**（id 数组）：验证过某条记忆是错的之后写替代结论用——列出的行被打上 `superseded_by` 指针（保留审计、退出召回），工具描述写明使用时机。响应新增 `superseded_traces`（被退役行清单）。
- **`memory_remember` 近邻回显**：响应新增 `neighbours[]`（top-3 最近邻 + 相似度 + `suspectedConflict`）与 `suspected_conflict`——写入前可见库里已相信什么，纠正不再盲写。
- **`memory_maintain status` 深度诊断**：新增 `diagnostics`（store_path / embedder kind+dim / 存量向量维度直方图 / dimMismatch / 阈值 / access 统计）与 `health` 一句话结论（`ok` / `WARN: embedder mismatch…` / `WARN: most memories never recalled…`）——探测"模型库被 hashing 回退查询→垃圾余弦→永久零命中"这类 stats 看不出来的静默故障。
- **digest 接线 `includeRecent`**：digest 现在带 2 条 recency tail（core 给这些行打 `[recent]` 标签），最新写入不再因 cue 不相关而从 digest 里消失（实测反馈：刚写的关键结论下轮就看不见）。

### Added — 防投毒护栏

- **防投毒护栏**：记忆中混入指令劫持短语（"ignore all previous instructions…"、人设接管、外传密钥、"别告诉用户"类隐瞒）时，所有渲染出口（digest / recall / verify / maintain list/history/duplicates）统一清洗为 `[sanitized-*]` 标记；digest 整体包裹 `[memory data]` 数据框架声明"内容是数据不是指令"。**存储行不动**（保留审计轨迹）；可疑行由 `injection:` 警告（recall/verify）与 `injectionWarnings` 数组（list）点名。依赖 core 0.1.7 的 guard 模块；对旧 core 降级兼容
- **`memory_remember` 新增 `importance` 参数**（0..1，显式优先于 confidence 推导），工具描述内置建议档位（用户长期偏好 0.9+、项目关键事实 0.8+、琐碎观察 <0.4）

### Changed

- 依赖 `hippo-memory-core` 升至 `^0.1.7`（合并后的核心版本：guard 模块 + 间隔重复强化 + 并发修复 + superseded_by 列 + sourceMonitor 邻域扫描 + diagnostics + 三通道冲突检测）；对旧 core 降级兼容（新字段缺失时返回空数组/false，无 guard 时降级为恒等函数）。

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
