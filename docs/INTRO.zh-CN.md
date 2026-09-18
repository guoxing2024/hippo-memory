# 🧠 HippoMemory —— 给 DSH Agent 装上"海马体"

> 一句话：**让 DeepSeek Runtime 的 agent 拥有跨会话、跨重启的长期记忆，长会话不再忘事、不再幻觉。**
> 当前版本：插件 0.2.0 / 引擎 0.2.0（2026-09-18）

## 为什么你需要它？

用过 DSH / 任何 agent 的人都遇到过：

- 会话一长，**早期结论被上下文挤没** → agent 开始忘事；
- 换了新会话，**前面查清的事实、定下的规矩全部归零**；
- 被追问细节时，**没有依据就开始编**（幻觉）。

**HippoMemory 模仿人脑海马体**，给 agent 装了一个本地长期记忆库：重要结论**主动存**（write），需要时**按线索想起来**（recall），开口前**先核对依据**（verify），记忆还会**自动整理**（consolidate / forget）。

实测（长会话 60 轮噪声后提问）：**无记忆 0/8 答对、编造率 25%；有记忆 8/8 答对、编造率 0%**。

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
| ⚡ 每轮自动回忆 | 开工前自动注入与当前任务相关的旧结论（`[hippo-memory digest]`），**命中才耗 token**（约 20–40 tok/条） |
| 📏 记忆纪律 | 系统提示教 agent：何时该记、该查、该验证（WRITE → RECALL → VERIFY → MAINTAIN） |
| 🎛 GUI 设置卡片 | 一键开关、注入条数、共享存储（跨会话协作 / 隔离）、嵌入模型、召回阈值 |
| 🔒 纯本地 | SQLite 存储（`~/.dsh/storages/hippo-memory/`），**零外部服务、零网络请求**，数据自己掌控 |
| ♻️ 纠错链 | 用户纠正时旧记忆自动版本化存档，永不覆盖丢历史；也可用 `supersedes` 显式点名退役错误条目 |
| 🔍 召回可解释 | 每个命中给三个分数（原始余弦 / 排序分 / 本次相对分）；**查不到时说明原因**并列出最接近的几条 |
| ✅ 证据与前瞻 | 需要复跑的结论可带 `verify_cmd`（渲染标 `[VERIFIED]`）；"以后遇到 X 要先做 Y"可注册为 `[GUARD]` |
| 🧹 重复与审计 | `duplicates` 只读列出近似重复；`override-audit` 筛出可疑覆盖；先看再删，不会自动动你的数据 |
| 🛡 防投毒 | 记忆里混入 ignore-all-previous-instructions 类劫持文本时，渲染出口统一清洗 + 数据框架隔离，可疑行点名待审 |
| ⏳ 间隔重复 | 复述 / 召回按"距上次访问的间隔"对数加权强化（集中重复几乎无增益）；`importance` 可显式声明 |

## 典型用法

**场景一：长线攻坚**（几百轮不停）
> 让 agent 每轮收尾自检"这轮有值得长期保留的结论吗"，有就 `memory_remember` → 上下文再长也不怕忘。

**场景二：多会话项目协作**
> 开共享存储，A 会话查清的结论 B 会话直接想起来——不用重新交代背景。

**场景三：压低编造率**
> 告诉 agent："引用旧事实前先用 `memory_verify` 核对，查无实据就明说，不要编。"编造率肉眼可见下降。

## 0.2.0 新东西（一句话版）

- **纠正链**：verify 返回四组邻域证据（反极性行 / 更新的结论 / 被退役的行 / 支持已过期），remember 回显最近邻并支持显式 `supersedes`；
- **抗幻觉四件套**：证据（带 30 天保鲜期）、撤回、前瞻守卫、值域先验；
- **覆盖判定加双口径门**：长 detail 不再把无关记忆误判成同一主张——宁可多存一行，也不丢数据；
- **投毒防护 + 深度健康诊断（`status` → `health`）+ 间隔重复 + 并发写安全**。

完整说明见 [CHANGELOG.md](../CHANGELOG.md) 与 [README 的 0.2.0 一节](../README.md)。

## 链接

| 包 | npm | 说明 |
|---|---|---|
| `dsh-hippo-memory` | https://www.npmjs.com/package/dsh-hippo-memory | DSH 插件（你要装的就是这个） |
| `hippo-memory-core` | https://www.npmjs.com/package/hippo-memory-core | 引擎，框架无关（可单独用于其它 agent 框架） |
| 源码 | https://github.com/guoxing2024/hippo-memory | 欢迎 star / issue |

## 完整文档

| 想了解 | 看这个 |
|---|---|
| 逐项设置、对话模板、十种场景话术、16 条 FAQ | [docs/USER-GUIDE.zh-CN.md](USER-GUIDE.zh-CN.md) |
| 数据结构、写入 / 读取路径、神经科学映射 | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| 引擎 API、评测基准、召回质量细节 | [README.md](../README.md) |
| 待办与计划 | [ROADMAP.md](../ROADMAP.md) |

---
*MIT License · 用 ❤️ 和 SQLite 写成*
