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
| **嵌入模型** | off | off = 内置快速哈希嵌入；auto = 懒加载本地 bge-small-zh-v1.5（约 100MB，缓存于 storages/hippo-memory/models），中文/同义表达召回显著增强；加载失败自动回退哈希 |
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

## 📄 License

MIT
