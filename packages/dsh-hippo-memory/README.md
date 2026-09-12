# 🧠 dsh-hippo-memory

**海马体式长期记忆插件** —— 让 DeepSeek Runtime (DSH) 的 agent 拥有"跨会话、跨项目、抗遗忘"的长期记忆。

```
没有本插件：长会话 → 上下文爆掉 → 旧事实被挤没 → 幻觉 / 自相矛盾
有本插件：   重要结论自动沉淀 → 每轮按需唤起 → 断言前先查证 → 不再凭空编造
```

> 引擎层为独立包 [`hippo-memory-core`](https://www.npmjs.com/package/hippo-memory-core)，本包是 DSH 适配层（工具 + 自动注入 + 纪律 + GUI 设置卡片）。

---

## ✨ 它给 agent 加了什么

| 能力 | 说明 | 何时触发 |
|---|---|---|
| **4 个记忆工具** | `memory_remember` 写 / `memory_recall` 查 / `memory_verify` 校验 / `memory_maintain` 整理 | agent 自主判断（有纪律提示词引导） |
| **召回可解释** | `memory_recall` 每个命中给出 `similarity`（原始余弦）/ `score`（含重要性加权）/ `relativeScore`（本次相对分）三个分数 | 需要判断“像不像”时 |
| **空结果给原因** | 没查到时会说明 `reason`（`below-threshold` 有相关但没过门槛 / `no-candidates` 库里没有或全被筛掉）并列出 `nearMisses` | 每次 `memory_recall` |
| **重复记忆报告** | `memory_maintain duplicates` 只读列出近似重复（跨类型比对，忽略 `FACT: `前缀），不删任何数据 | 手动整理时 |
| **自动摘要注入** | 每轮开工前，若记忆库里有与当前任务相关的旧结论，自动注入一条 `[hippo-memory digest]` 参考块 | 引擎自动，命中才耗 token（约 20–40 tok/条） |
| **使用纪律** | 系统提示里教 agent：何时该记、该查、该验证（WRITE→RECALL→VERIFY→MAINTAIN） | 插件启用即注入 |
| **GUI 设置卡片** | 设置 → 插件 → 插件配置 → HippoMemory 记忆 | 随时开关、调参 |

## 📦 安装

```bash
# 在 dsh 的 web（或其它）profile 里安装
dsh plugin --profile web add dsh-hippo-memory

# 重启该 profile 生效
dsh web
```

装完打开 **设置 → 插件 → 插件配置**，应能看到 "HippoMemory 记忆" 卡片（默认启用）。

## ⚙️ 设置项（GUI 卡片里调整）

| 字段 | 默认 | 含义 |
|---|---|---|
| **启用** | 开 | 关掉 = 卸载全部记忆工具/纪律/自动注入（记忆数据保留，再开即恢复） |
| **上下文条数上限** | 6 | 每轮自动注入的记忆摘要条数上限（1–20；越大越耗 token） |
| **共享存储** | 关 | 开 = 该 profile 内所有会话共用一个记忆库；关 = 每会话独立库 |
| **嵌入模型** | off | off = 内置快速哈希嵌入；auto = 懒加载本地 bge-small-zh-v1.5（量化版约 24MB，缓存于 storages/hippo-memory/models），中文/同义表达召回显著增强；下载与就绪有日志提示，加载失败自动回退哈希 |
| **召回阈值** | 留空 | 召回/验证相似度下限（0.05–0.95）。留空用引擎默认 0.32。调低=更宽松召回，调高=更严格 |

> ⚠️ **共享存储**建议想清楚再开：开共享后，A 会话写的事实 B 会话能查到（协作），但也会互相污染（B 会看到 A 的无关内容）。单项目多会话协作开它，多项目混跑保持关闭。

## 🧠 怎么让 agent 真正用起来

插件**默认启用即生效**，但模型对工具是"自主调用"。想让某个会话认真用记忆，直接对它说：

```
从现在起：学到的持久结论要调用 memory_remember 存入长期记忆；
被问及旧事实/旧决策前先 memory_recall 查记忆库；断言记忆前用 memory_verify 校验；
每轮收尾自检有没有值得长期保留的结论。
```

记忆按**会话独立**存放（除非开了共享存储）：
- 每个会话的记忆在 `~/.dsh/storages/hippo-memory/session-<id>.db`
- 记忆不会因会话删除/上下文清空而丢失
- 插件关闭再开启，数据仍在

> 💡 **开启 auto 后**：旧记忆自动一次性重嵌入为模型向量（日志出现 `re-embedded N legacy memory row(s)`），无需手动迁移。
> 用 `memory_maintain` 的 `status` action 可随时查嵌入模型状态（off/loading/ready/failed）。

## 🔬 召回结果怎么看（0.1.8 起）

**三个分数别混着看。** `memory_recall` 的每个命中带三个数：

| 字段 | 含义 |
|---|---|
| `similarity` | **原始余弦**。与「召回阈值」、与 `memory_verify` 的分**同口径**，可直接比较——判断“像不像”以它为准 |
| `score` | 排序分 = `similarity × (0.6 + 0.4 × importance)`，再叠加标识符加成，上限 1.0。**它不等于相似度** |
| `relativeScore` | `similarity ÷ 本次最高 similarity`（1.0 = 本次最佳）。余弦值被压缩且依赖查询，用它判断“这条算不算本次最相关” |

> 曾有人看到 “`memory_verify` 给 0.604，`memory_recall` 只给 0.449”，以为 recall 更弱。其实是**口径不同**：verify 报原始余弦，recall 报含重要性乘数的 `score`。用 `similarity` 就能对上。

**查到空结果时**，返回里会说明原因，不再是一个空数组：

| 字段 | 含义 |
|---|---|
| `reason` | `below-threshold`（有相关记忆但都没过阈值）/ `no-candidates`（库里没有或全被筛掉）/ `empty-cue`（没给 query）/ `ok` |
| `eligible` / `bestSimilarity` / `threshold` | 通过筛选的条数 / 候选里最高原始余弦 / 本次生效阈值 |
| `nearMisses` | 最接近的几条（含分值与摘要），一眼看出“差一点”的是哪条 |

**标识符查询（0x… / D-387 / commit sha）为什么能命中**：裸标识符做嵌入查询余弦极低，但精确 token 命中比余弦更可靠，所以这类记忆即使低于阈值也会召回，并标 `literalMatch`（共享 token 数）。

**被覆盖的记忆去哪了**：`memory_remember` 覆盖旧值时返回 `superseded`（含被替换的 id / 版本 / 摘要），旧版进 `history` 存档、**不是静默丢弃**，可用 `memory_maintain history` 查演变。

**重复记忆**：${BT}memory_maintain${BT} 的 action 现在支持 `duplicates`（只读报告，不删除）。重复主要来自整合时生成的 `FACT: ` 规则副本；写入路径已修，不会再生新的。确认后用 `delete` 逐条清理。

---

## 🔍 常见问题

**Q：旧对话为什么查不到记忆？**
插件只从它装上、启用那一刻开始工作。更早的对话没有经过记忆工具，不会自动补录——可在旧对话里要求 agent 把要点用 `memory_remember` 补写进去。

**Q：`memory_recall` 报 "value is not lossless JSON"？**
已修复（0.1.x 需 ≥ 修复版）：返回结果做了 JSON 清洗。请升级并重启 profile。

**Q：`memory_verify` 说 UNSUBSTANTIATED，但我觉得明明记过？**
哈希嵌入对"同义不同词"的召回偏弱（尤其中文）。**推荐开启设置里的「嵌入模型 = auto」**——本地 bge-small-zh 模型对中文/同义表达的召回显著增强。也可用更接近原 summary 的措辞再查，或开共享存储 + 明确 entity。`memory_verify` 现在会返回 `closest`（最接近的候选），帮助你判断"差一点命中"的是哪条。

**Q：会不会很费 token？**
不会。写入/查询是 agent 主动调用才发生；自动注入只在"命中相关记忆"时产生 ~20–40 tok/条，无命中为 0。条数上限可调。

**Q：数据安全吗？**
纯本地 SQLite（`~/.dsh/storages/hippo-memory/`），零外部服务、零网络请求。可选接本地嵌入模型增强召回（需自行配置 `setEmbedder`）。

## 🗂 数据位置

| 内容 | 路径 |
|---|---|
| 每会话记忆库 | `~/.dsh/storages/hippo-memory/session-<id>.db` |
| 共享记忆库 | `~/.dsh/storages/hippo-memory/shared.db` |
| 插件设置 | `~/.dsh/settings.yaml`（`hippo-memory:` 节） |

删除对应 `.db` 即清空该记忆（谨慎）。

**Q：memory_recall 只给 0.4 多，是不是没记住？**
不一定。先看 `similarity`（原始余弦，可与阈值直接比）和 `relativeScore`（1.0 = 本次最佳）。余弦本身被压缩，0.45 也可能是全库最佳。若 `reason` 是 `below-threshold`，看 `nearMisses` 就知道是“真没有”还是“阈值偏高”（可去设置里调低「召回阈值」）。

**Q：怎么知道记忆库有没有垃圾/重复？**
调 `memory_maintain` + action `stats` 看总量，用 action `duplicates` 看近似重复分组。两个都是只读的；确认后再用 action `delete` 加 id 删除（会连版本历史一起删，不可恢复）。

## 📄 License

MIT
