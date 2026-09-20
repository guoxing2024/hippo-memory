# 🧠 opencode-hippo-memory

**给 opencode 装上海马体式长期记忆** —— 跨会话、跨压缩、抗遗忘，纯本地 SQLite。

```
没有它：   会话一长 → 上下文压缩 → 早期结论蒸发 → 模型凭印象编
有本插件： 重要结论自动沉淀 → 每轮按需唤起 → 断言前先查证 → 有据才答
```

> 引擎是框架无关的 [**`hippo-memory-core`**](https://www.npmjs.com/package/hippo-memory-core)（≥ 0.3.0，自带 Bun 支持）；本包是 **opencode 适配层**（当前 0.3.0，已发布到 npm）。
> 本仓库里的 DSH 版是 [`dsh-hippo-memory`](https://www.npmjs.com/package/dsh-hippo-memory) —— **两个宿主不通用**，别装错。

---

## ✨ 它给 opencode 加了什么

| 能力 | 说明 |
|---|---|
| **4 个记忆工具** | `memory_remember` 写 / `memory_recall` 查 / `memory_verify` 断言前查证 / `memory_maintain` 维护（status / stats / list / history / duplicates / merge / undemote / override-audit / consolidate / forget / delete，共 11 个动作） |
| **每轮自动注入** | 用当前对话当线索，把相关旧结论拼成 `[hippo-memory digest]` 块注入系统提示；**命中才耗 token**。全部低于门槛时不再空白：最接近的那条作为第 1 行给出并标明 `[low-confidence … not a memory]`（0.3.0） |
| **压缩前保住结论** | 会话压缩（compaction）前把持久记忆附进压缩上下文，压缩后不丢关键结论 |
| **使用纪律** | 系统提示追加一小节，教模型 WRITE → RECALL → VERIFY → MAINTAIN，查无实据就说"记不清" |
| **前提作用域** | `memory_remember` / `memory_verify` / `memory_recall` 都接受 `scope`（`key=value; …`）：写入换口径的重测各存各的、verify 会答 `out_of_scope`、recall 按前提**硬过滤**冲突行并回 `scopeExcluded`（0.3.0） |
| **重复合并** | `memory_maintain { action: "duplicates" }` 只读报告同一句话的重述（每组带 `mixedPremises`），确认后 `{ action: "merge", ids: [...] }` 折叠成一条：默认预览，`dry_run: false` 才落地，多余行不删、`undemote` 可恢复（0.3.0） |
| **隔壁那个库看得见** | `status` 除 `health` / 诊断外，新增 `path_rule`（本项目库文件名的由来）、`sibling_stores`（同目录每个 `.db` 各有多少行）、`coverage`（本进程 digest 门槛的读数）；本库空而隔壁满时 `health` 第一句就是"记在另一个文件里"（0.3.0） |
| **纯本地** | SQLite（`node:sqlite` / `bun:sqlite` 自动选），零外部服务、零 API key、零网络请求 |

---

## 📦 安装

```bash
# 全局（推荐）：所有项目都能用
opencode plugin -g opencode-hippo-memory

# 或者只装在当前项目
opencode plugin opencode-hippo-memory
```

装完**重启 opencode** 生效（配置只在启动时读一次）。

### 确认装上了

```bash
opencode debug info        # plugins: 一行里应出现 opencode-hippo-memory
```

然后随便开一个会话问模型：`"列出你有哪些 memory_ 工具"` —— 能看到 4 个就通了。

### 手动安装（等价做法）

在 `~/.config/opencode/opencode.json`（或项目的 `.opencode/opencode.json`）里写：

```json
{ "plugin": ["opencode-hippo-memory"] }
```

### ⚠️ 一个很容易踩的坑

`plugin` 里写**纯包名**时，opencode 会把它当 registry 规范，去 npm 现装到
`~/.cache/opencode/packages/<spec>/node_modules/opencode-hippo-memory` —— **它不读 `~/.config/opencode/node_modules`**。
所以"在配置目录里手工 `npm install` 一个 tgz"是不会生效的，而且：

- 装失败**不写日志**（服务端加载器的 `missing` 回调是空函数，install 错误只发一条一次性 TUI 提示）；
- `opencode debug info` 里**照样会列出包名**（那只是配置回显，不代表加载成功）。

因此本地开发请用 `opencode plugin <本地目录>`（会解析成 `file://` 规范），或者直接写路径：

```json
{ "plugin": ["file:///absolute/path/to/opencode-hippo-memory"] }
```

排查是否真的加载了，别看 debug info，看**副作用**：跑一轮会话后应出现
`<store 目录>/<项目名>.db`（见下文"数据位置"），或问模型要 `memory_` 工具列表。

升级后版本没变也是这个原因：opencode 的缓存目录按**规范原文**命名
（`~/.cache/opencode/packages/opencode-hippo-memory@latest`），命中就完全不查 registry。
更新要么用 `opencode plugin -g -f opencode-hippo-memory`，要么删掉那个目录再启动。

---

## ⚙️ 设置

插件选项通过 opencode 配置的 `plugin` 二元组传入：

```json
{
  "plugin": [
    ["opencode-hippo-memory", {
      "enabled": true,
      "contextLimit": 5,
      "sharedStore": false,
      "discipline": true,
      "similarityThreshold": null
    }]
  ]
}
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉 = 不注册工具、不注入（**数据保留**） |
| `contextLimit` | `5` | 每轮注入的记忆条数上限 |
| `sharedStore` | `false` | `true` = 本机所有项目共用 `shared.db`；`false` = 每个项目一个库 |
| `discipline` | `true` | 是否追加使用纪律小节 |
| `similarityThreshold` | `null` | 召回门槛；`null` 用引擎默认 0.32。调低更宽松、调高更严格 |

---

## 🧠 怎么让它真的被用起来

插件默认启用，但**工具调用是模型自己决定的**。想在某个项目里让它认真用记忆，把这段贴进 `AGENTS.md`：

```markdown
这个项目启用了长期记忆（memory_* 工具）：
- 学到持久结论、做完决策 → memory_remember（summary 用 <主体> -> <结论>）
- 只在某种条件下成立的结论（样本范围、比较基准、版本）→ 带上 scope: "key=value; key=value"
- 回答涉及旧事实/旧决策 → 先 memory_recall，别只凭当前上下文猜
- 断言记忆里的东西之前 → memory_verify（问的也是同一个 scope）；没依据就说"记忆里没有"，
  out_of_scope 就说明库里那条属于别的前提，不要搬用
```

---

## 🔬 召回结果怎么看

`memory_recall` 的每个命中带**三个分数**，别混着看：

| 字段 | 含义 |
|---|---|
| `similarity` | **原始余弦** —— 与门槛、与 `memory_verify` 同口径，判断"像不像"用它 |
| `score` | 排序分 = `similarity × (0.6 + 0.4 × importance)`，**不等于相似度** |
| `relativeScore` | 本次查询内的相对分，1.0 = 本次最佳 |

查不到时不给空数组，而是说明原因：`reason` = `below-threshold`（有相关但没过门槛，看 `nearMisses`）/ `no-candidates`（库里没有或全被筛掉）。`memory_recall` 从 0.3.0 起接受 `scope`：传了就按前提**硬过滤**冲突行（属于别的前提的行整条排除），返回里 `scopeExcluded` 计数排掉了几条。

写入的结局看 `outcome`，不要数行数：`new` 新增 / `none` 复述强化（不新增行）/ `merge` 并入 / `override` 同主体换值（旧版归档、带 warning 指名退役对象）/ `supersede` 显式退役。命中与写入结果都带 `scope`（这条结论声明的前提，未声明为 `null`）；带前提的新写与库里的旧前提对不上时走 `new` 并附 `different-scope:` 警告，而不是覆盖。`memory_remember` 复述时若带上新证据（`verify_result:"pass"`），返回顶层回显 `verify_result` / `verified_at`（没带证据为 `null`）。

---

## 🗂 数据位置

| 内容 | 路径 |
|---|---|
| 每项目记忆库 | `<store 根>/<项目目录名>.db` |
| 共享记忆库（`sharedStore: true`） | `<store 根>/shared.db` |

`<store 根>` 按环境解析：设了 `XDG_CACHE_HOME` 用它（`$XDG_CACHE_HOME/opencode/hippo-memory`）；
Windows 用 `%LOCALAPPDATA%\opencode\hippo-memory`；其余平台用 `~/.cache/opencode/hippo-memory`。
删除对应 `.db` 即清空该项目的记忆（建议先退出 opencode）。

---

## ❓ 常见问题

**Q：和 `dsh-hippo-memory` 什么关系？**
同一个引擎的两个宿主适配层，**互不通用**：DSH 用前者，opencode 用本包。数据也不通用——DSH 按 agent id 分库（`~/.dsh/storages/hippo-memory/`），opencode 按项目目录分库（`<缓存根>/opencode/hippo-memory/`）。在 DSH 里记下的结论，到 opencode 查就是"没记过"；反之同理。

**Q：换个项目 / 换个会话就查不到了？**
先分清两种"查不到"。本包默认**每个项目目录一个库**：A 项目的结论在 B 项目里本来就读不到（不是没记住）。想全项目共用一个库，把 `sharedStore: true` 写进 `plugin` 的设置项。判据在 `memory_maintain { action: "status" }` 里（0.3.0）：`path_rule` 说明这个文件名怎么来的，`sibling_stores` 列出同目录每个 `.db` 各有多少行，本库 0 行而隔壁有货时 `health` 直接说"记在另一个文件里"。

**Q：装完没反应？**
先看上面"⚠️ 一个很容易踩的坑"——`opencode debug info` 列出包名**不代表加载成功**。按顺序查：
重启 opencode（配置只在启动时读）→ 跑一轮会话，看 store 目录里有没有生成 `.db` → 没有就确认包已发布到 npm
（`npm view opencode-hippo-memory version`）且 `plugin` 里是纯包名或有效的 `file://` 路径。

**Q：会多花很多 token 吗？**
自动注入**命中才发生**（每条约 20–40 token），没命中就是 0；条数用 `contextLimit` 控。工具调用只在模型主动用时发生。

**Q：查旧结论查不到？**
先 `memory_maintain` → `status`：一句话 `health` + 诊断（驱动、向量维度、`dimMismatch`、阈值）。默认哈希嵌入只认字面词，中文同义改写召回偏弱——换成语义模型（引擎侧 `setEmbedder()`）或把 query 写得贴近原文。

**Q：同一句话换个测量口径测出不同数字，会被当成同一条记忆吗？**
会——除非写入时带 `scope`（`key=value; key=value`，如 `population=all rows; comparator=instruction start`，0.3.0）。带上之后：前提对不上的两条结论各自留存、互不覆盖（写入回显 `different-scope:` 警告）；`memory_verify` 也要带 `scope` 问，库里那条属于别的前提时它答 `out_of_scope`（`substantiated`、`contradicted` 都为 `false`），而不是把旧口径的结论盖到新口径的问题上。

**Q：压缩之后记忆还在吗？**
在。数据在 SQLite 里，与上下文无关；本插件还会在压缩前把持久记忆塞进压缩上下文 (`experimental.session.compacting`)，减少"压缩后忘事"。

---

## 📄 License

MIT
