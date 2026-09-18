# 🧠 dsh-hippo-memory

**海马体式长期记忆插件（DSH）** —— 让 DeepSeek Runtime 的 agent 拥有跨会话、跨重启、抗遗忘的长期记忆。

```
没有它：   长会话 → 上下文爆掉 → 旧事实被挤没 → 幻觉 / 自相矛盾
有本插件： 重要结论自动沉淀 → 每轮按需唤起 → 断言前先查证 → 不再凭空编造
```

> 引擎（框架无关）是独立包 [`hippo-memory-core`](https://www.npmjs.com/package/hippo-memory-core)；本包是 DSH 适配层：工具 + 自动注入 + 使用纪律 + GUI 设置卡片。
> ⚠️ 本包是 **DSH 专属**适配层，**不能在 opencode 等其它宿主里安装**。引擎 `hippo-memory-core` 自 0.2.1 起可在 Bun 上运行（opencode 用 Bun）；面向 opencode 的适配包 `opencode-hippo-memory` 在本仓库 `packages/` 下开发中。
>
> 当前版本：**0.2.1**（与引擎 0.2.0 同步）。详细使用说明见 [完整中文使用说明](https://github.com/guoxing2024/hippo-memory/blob/master/docs/USER-GUIDE.zh-CN.md)。

---

## ✨ 它给 agent 加了什么

| 能力 | 说明 | 何时触发 |
|---|---|---|
| **4 个记忆工具** | `memory_remember` 写 / `memory_recall` 查 / `memory_verify` 校验 / `memory_maintain` 维护（12 个动作） | agent 自主判断（有使用纪律引导） |
| **每轮自动回忆** | 用你这一轮的话当线索，把相关旧结论注入一条 `[hippo-memory digest]` 块；**命中才耗 token**（约 20–40 tok/条） | 每轮开工前自动 |
| **记忆纪律** | 系统提示教 agent：何时记、何时查、何时验（WRITE → RECALL → VERIFY → MAINTAIN） | 插件启用即注入 |
| **纠正链** | `memory_verify` 返回 `contradicting[]` / `newer_related[]` / `superseded_matches[]` / `stale_support`；`memory_remember` 回显 `neighbours[]` 并接受 `supersedes` | 0.2.0 起 |
| **证据与前瞻** | `verify_cmd` / `verify_expect` / `verify_artifact` + 保鲜期；`retracts` 撤回；`guard_trigger` / `guard_action` 前瞻守卫 | 写入时可选 |
| **防投毒护栏** | 渲染出口统一清洗指令劫持文本为 `[sanitized-*]`，digest 整体包 `[memory data]` 数据框架；**存储原文不动**，可疑行由 `injection:` 警告点名 | 引擎自动 |
| **可观测性** | `status` 返回一句话 `health` + 深度诊断（嵌入器类型/维度、向量维度直方图、`dimMismatch`、阈值、访问统计） | 怀疑召回坏了时 |
| **间隔重复** | 复述 / 召回按距上次访问的间隔对数加权强化；`importance` 可显式声明 | 引擎自动 |
| **GUI 设置卡片** | 设置 → 插件 → 插件配置 → HippoMemory 记忆 | 随时开关、调参 |

---

## 📦 安装 / 升级

```bash
# 安装在 web profile（图形界面那个）
dsh plugin --profile web add dsh-hippo-memory

# 升级到 0.2.0
dsh plugin --profile web update dsh-hippo-memory

# 重启该 profile 生效（必须完整退出，不是刷新页面）
dsh web
```

装完打开 **设置 → 插件 → 插件配置**，应能看到 HippoMemory 记忆 卡片（默认启用）。

> 其它 profile 把 `web` 换成对应名字（如 `headless`）。升级 0.2.0 是**数据零迁移**：旧记忆库照常读取，新字段只对新写入生效。

---

## ⚙️ 设置项（GUI 卡片里调整）

| 字段 | 默认 | 含义 |
|---|---|---|
| **启用** | 开 | 关掉 = 卸载全部记忆工具 / 纪律 / 自动注入（**记忆数据保留**，再开即恢复） |
| **上下文条数上限** | 6 | 每轮自动注入的记忆摘要条数上限（1–20，越大越耗 token） |
| **共享存储** | 关 | 开 = 该 profile 内所有会话共用一个记忆库；关 = 每会话独立库 |
| **嵌入模型** | off | `off` = 内置快速哈希嵌入；`auto` = 懒加载本地 bge-small-zh-v1.5（量化约 24MB，缓存于 `storages/hippo-memory/models`），中文 / 同义表达召回显著增强；加载失败自动回退哈希 |
| **召回阈值** | 留空 | 召回 / 验证相似度下限（0.05–0.95）。留空用引擎默认 0.32。调低 = 更宽松召回，调高 = 更严格 |

> ⚠️ **共享存储**建议想清楚再开：开共享后 A 会话写的事实 B 会话能查到（协作），但也会互相串味。单项目多会话协作开它，多项目混跑保持关闭。

---

## 🧠 怎么让 agent 真正用起来

插件**默认启用即生效**，但工具调用是模型自主决定的。想让某个会话认真用记忆，直接把这段话发给它：

```
从现在起：学到的持久结论要调用 memory_remember 存入长期记忆（summary 用 主体 -> 结论 格式）；
被问及旧事实 / 旧决策前先 memory_recall 查记忆库；断言记忆前用 memory_verify 校验；
每轮收尾自检有没有值得长期保留的结论。查无实据就直说，不要编。
```

记忆默认按**会话独立**存放：

- 每个会话的记忆在 `~/.dsh/storages/hippo-memory/session-<id>.db`；
- 记忆不会因会话删除 / 上下文清空而丢失；插件关闭再开启，数据仍在。

---

## 🛠 工具速查

### `memory_remember` —— 写入

必填 `kind`（episode 事件 / semantic 规则 / procedure 技能）与 `summary`（一句话）。常用可选：

| 参数 | 用途 |
|---|---|
| `detail` | 原始细节（供深度回顾） |
| `entities` / `tags` | 实体（检索 + 冲突范围）/ 自由标签 |
| `source` / `confidence` | 来源（user / tool / config / agent）与写者可信度 |
| `importance` | 0..1 显式重要度（用户长期偏好 0.9+、项目关键事实 0.8+、一次性观察 <0.4） |
| `verify_cmd` / `verify_expect` / `verify_artifact` / `verify_result` / `verified_at` | 可复算的出处（引擎**不执行命令**，只存档 + 把关渲染） |
| `supersedes` | id 数组：显式退役错误记忆（纠正链） |
| `retracts` | 本写入撤回的 id（配合 `tags: ["retraction"]`） |
| `guard_trigger` + `guard_action` | 前瞻守卫（配合 `tags: ["guard"]`） |

返回：`outcome`（new / none / merge / override / supersede）、`id`、`version`、`superseded`、`neighbours[]`、`warning`、`scope_only_matches`。

### `memory_recall` —— 检索

`query` 必填；`entities` / `kind` / `limit`（默认 8，上限 20）/ `include_demoted` 可选。

### `memory_verify` —— 断言前查证

`claim` 必填，返回 `substantiated` / `contradicted` / `closest` + 四组证据（见上表）。

### `memory_maintain` —— 维护（12 个动作）

| 动作 | 作用 | 风险 |
|---|---|---|
| `consolidate` | 高频 episode 抽象成 semantic 规则 | 只新增 |
| `compress` / `undemote` | 图式压缩（预览 → `plan_json` 落库）/ 恢复折叠行 | 折叠可逆 |
| `forget` / `prune` | 衰减弱记忆（默认 dry_run）/ 清理空库文件 | 软删除 / 只删空文件 |
| `stats` / `list` / `history` | 统计 / 清单 / 版本史 | 只读 |
| `duplicates` / `override-audit` / `status` | 重复报告 / 覆盖事故审计 / 嵌入器与库健康诊断 | 只读 |
| `delete` | **永久删除**某条（含版本历史） | ⚠️ 不可恢复 |

---

## 🔬 召回结果怎么看

**三个分数别混着看。** `memory_recall` 的每个命中带三个数：

| 字段 | 含义 |
|---|---|
| `similarity` | **原始余弦**。与召回阈值、与 `memory_verify` 同口径，判断像不像以它为准 |
| `score` | 排序分 = `similarity × (0.6 + 0.4 × importance)`，再叠加标识符加成，上限 1.0。**不等于相似度** |
| `relativeScore` | `similarity ÷ 本次最高 similarity`（1.0 = 本次最佳） |

> 曾有人看到 `memory_verify` 给 0.604、`memory_recall` 只给 0.449，以为 recall 更弱。其实是口径不同：verify 报原始余弦，recall 报含重要性乘数的 `score`。用 `similarity` 就能对上。

**查到空结果时**，返回里会说明原因，不再是一个空数组：

| 字段 | 含义 |
|---|---|
| `reason` | `below-threshold`（有相关记忆但没过阈值）/ `no-candidates`（库里没有或全被筛掉）/ `empty-cue`（没给 query）/ `ok` |
| `eligible` / `bestSimilarity` / `threshold` | 通过筛选的条数 / 候选里最高原始余弦 / 本次生效阈值 |
| `nearMisses` | 最接近的几条（含分值与摘要），一眼看出差一点的是哪条 |

**标识符查询（0x… / D-387 / commit sha）为什么能命中**：裸标识符做嵌入查询余弦极低，但精确 token 命中比余弦更可靠，所以这类记忆即使低于阈值也会召回，并标 `literalMatch`。

**被覆盖的记忆去哪了**：覆盖时返回 `superseded`（被替换的 id / 版本 / 摘要），旧版进 `history` 存档、**不是静默丢弃**；也可用 `override-audit` 事后筛出可疑覆盖。

**写入的结局怎么看**：看 `outcome`，不要数行数——`none`（复述强化）和 `merge`（并入）都不会新增行。

---

## 🔍 常见问题

**Q：旧对话为什么查不到记忆？**
插件只从它装上、启用那一刻开始工作。更早的对话没经过记忆工具，不会自动补录——可在旧对话里要求 agent 用 `memory_remember` 补写要点。

**Q：`memory_verify` 说 UNSUBSTANTIATED，但我明明记过？**
哈希嵌入对同义不同词的召回偏弱（尤其中文）。**推荐开启设置里的嵌入模型 = auto**。也可看 `closest`（最接近的候选是谁）、用更接近原 summary 的措辞再查，或带上实体名。

**Q：recall 只给 0.4 多，是不是没记住？**
不一定。先看 `similarity`（原始余弦，与阈值可直接比）与 `relativeScore`（1.0 = 本次最佳）。余弦被压缩，0.45 也可能全库最佳。若 `reason` 是 `below-threshold`，看 `nearMisses` 判断是真没有还是阈值偏高。

**Q：怎么知道记忆库健康？**
`memory_maintain` → `status`：一句话 `health` + 深度诊断。看到 `WARN: embedder mismatch` 说明模型向量库被哈希回退查询了（会导致永久零命中）。

**Q：会不会很费 token？**
不会。写入 / 查询是 agent 主动调用才发生；自动注入只在命中相关记忆时产生约 20–40 tok/条，无命中为 0。条数上限可调。

**Q：数据安全吗？**
纯本地 SQLite（`~/.dsh/storages/hippo-memory/`），零外部服务、零网络请求。可选本地嵌入模型增强召回（模型文件也缓存在本地）。

---

## 🗂 数据位置

| 内容 | 路径 |
|---|---|
| 每会话记忆库 | `~/.dsh/storages/hippo-memory/session-<id>.db` |
| 共享记忆库 | `~/.dsh/storages/hippo-memory/shared.db` |
| 嵌入模型缓存 | `~/.dsh/storages/hippo-memory/models/` |
| 插件设置 | `~/.dsh/settings.yaml`（`hippo-memory:` 节） |

删除对应 `.db` 即清空该记忆（建议先退出 dsh）。

## 📄 License

MIT
