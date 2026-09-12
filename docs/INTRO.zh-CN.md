# 🧠 HippoMemory —— 给 DSH Agent 装上"海马体"

> 一句话：**让 DeepSeek Runtime 的 agent 拥有跨会话、跨重启的长期记忆，长会话不再忘事、不再幻觉。**

## 为什么你需要它？

用过 DSH/Claude/任何 agent 的人都会遇到同一个痛点：

- 会话一长，**早期的关键结论被上下文挤没** → agent 开始忘事；
- 一忘事就**凭感觉编**（幻觉）或前后矛盾；
- 换个新会话，**项目里查清的事实、定下的规矩全归零**，又要重新交代一遍。

**HippoMemory 模仿人脑海马体**，给 agent 装了一个本地长期记忆库：
重要的**主动存**（write），需要时**按线索想起来**（recall），开口前**先核对依据**（verify），记忆**自动整理**（consolidate/forget）。

实测基准（长会话反幻觉对比）：**无记忆 0/8 答对 → 有记忆 8/8 答对**，编造率 25% → 0%。

## 安装（30 秒）

```bash
dsh plugin --profile web add dsh-hippo-memory
dsh web
```

重启后：**设置 → 插件 → 插件配置 → HippoMemory 记忆**，默认已启用。

## 它给你的 agent 加了什么？

| 能力 | 效果 |
|---|---|
| 🛠 4 个记忆工具 | `memory_remember` / `memory_recall` / `memory_verify` / `memory_maintain`，agent 自主调用 |
| ⚡ 每轮自动回忆 | 开工前自动注入与当前任务相关的旧结论（`[hippo-memory digest]`），**命中才耗 token**（20–40 tok/条） |
| 📏 记忆纪律 | 系统提示教 agent：何时该记、该查、该验证（WRITE→RECALL→VERIFY→MAINTAIN） |
| 🎛 GUI 设置卡片 | 一键开关、上下文条数上限、共享存储（多会话协作/隔离） |
| 🔒 纯本地 | SQLite 存储（`~/.dsh/storages/hippo-memory/`），**零外部服务、零网络请求**，数据自己掌控 |
| ♻️ 纠错覆盖 | 用户纠正时旧记忆自动版本化存档，永不"覆盖丢历史"，查到的永远是最新值 |
| 🔍 召回可解释 | 每个命中给出 `similarity`（原始余弦）/ `score`（含重要性加权）/ `relativeScore`（本次相对分）；**查不到时说明原因**（阈值内没命中 vs 库里没有）并列出最接近的几条 |
| 🧹 重复可查 | `memory_maintain duplicates` 只读列出近似重复记忆，确认后再删，不会自动动你的数据 |

## 典型用法

**场景一：长会话攻坚**（几百轮不停）
让 agent 每轮收尾自检"这轮有值得长期保留的结论吗"，有就 `memory_remember` → 上下文再长也不丢关键决议。

**场景二：跨会话项目协作**
开"共享存储"，A 会话查清的结论 B 会话开工自动想起——不用重新交代背景。

**场景三：防幻觉硬约束**
告诉 agent："断言记忆前先 `memory_verify`，查无实据就明说不知道。" → 编造率肉眼可见下降。

## 链接

| 包 | npm | 说明 |
|---|---|---|
| `dsh-hippo-memory` | https://www.npmjs.com/package/dsh-hippo-memory | DSH 插件（装这个） |
| `hippo-memory-core` | https://www.npmjs.com/package/hippo-memory-core | 框架无关引擎（可单独用于其它 agent 框架） |
| 源码 | https://github.com/guoxing2024/hippo-memory | 欢迎 star / issue |

## 完整文档

安装、GUI 设置逐字段解释、引导 agent 话术、数据备份/清空、FAQ → 见 [docs/USER-GUIDE.zh-CN.md](docs/USER-GUIDE.zh-CN.md)

---
*MIT License · 用 ❤️ 和 🧠 构建*
