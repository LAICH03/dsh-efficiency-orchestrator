# dsh-efficiency-orchestrator

**一个插件，两层接管。** 面向 [DeepSeek Harness](https://deepseek.com/harness)（DSH）的运行时插件：在单个宿主生命周期内，由一个进程内调度器统一编排四种「轮次 / 步骤效率」能力——OPS 只读工具抢占、推理防复读熔断、批量工具调用建议、会话预算守护。

与只贡献提示词的效率插件不同，本插件会**接管工具层**：把官方 `read` / `glob` / `grep` 从模型视野中替换为 `ops_inspect_local_file` / `ops_glob` / `ops_grep`。无论这三个官方工具注册在 profile 层（TUI / headless 组合），还是被 Web / Desktop 移进 Agent preset 层，插件都会在**对应的作用域**里完成注册与掩码——包括从 profile 级挂载强行接管 preset 作用域。

> **状态：developer preview。** 已在 DSH `0.2.2-rc.2` + `@deepseek-ai/cordis` `4.1.0` 上完成源码级与实机验证；其他宿主组合请以你的版本为准。

## English overview

A DeepSeek Harness host plugin with two kinds of leverage:

1. **Tool takeover.** It publishes `ops_*` aliases for the official `read` / `glob` /
   `grep` and hides the official names from every Agent. The takeover adapts to the
   composition: when the file tools are host rows it registers at profile scope and
   masks per Agent; when a surface (Web/Desktop) moves them into Agent presets it
   publishes **inside each Agent scope** at `agent/created`. A profile-level mount
   therefore still owns the model-visible tool set, without shipping a preset.
2. **Efficiency scheduling.** The same scheduler truncates degenerate reasoning
   loops inside `llm/stream`, contributes an opt-in batch tool-call policy section
   plus a one-shot post-compaction notice, and guards session budgets with a static
   reminder section and an optional hard stop.

No service is published; every registration is a Cordis effect owned by the plugin
fiber, or explicitly released with the Agent scope that owns it.

## 为什么需要「接管」而不是「建议」

模型能调用哪些工具，由 `ToolsService` 的 **scope 视图**决定；而 profile 级插件的
`ctx.tools.definitions()` 只看得到 global 层。问题在于 DSH 的两套官方组合并不一致：

- **TUI / headless**：`dsh-base` 把 `tool-fs`、`tool-fs-search` 作为 host 行挂载，
  `read` / `glob` / `grep` 在 profile 视图里；
- **Web / Desktop**：`@deepseek-ai/dsh-web-app/cordis.patch.yml` 把这两行
  `disabled: true`，改由 `presets/standard.patch.yml` 在每个 Agent 的 preset scope
  挂载——profile 视图里**一个都没有**。

因此，普通插件在 Web 端既注册不出替代工具（拿不到官方 `execute`），也掩不掉官方工具
（`ctx.tools.restrict()` 在无 scope 的 profile ctx 上会被 Host 拒绝）。本插件选择的
突破口是 `agent/created`：该事件在 preset 挂载完成之后、首次 prompt 组装之前派发，
此时 `agent.ctx.tools` 已经能看到 preset 的注册结果，也还没生成第一份工具声明。

## 能力一览

| 层 | 做什么 | 默认状态 |
|---|---|---|
| 工具层 | **双路径 OPS 接管**：探测 profile 视图；官方工具在 profile 则全局注册 `ops_*` 并对每个 Agent 掩码官方 `read`/`glob`/`grep`；官方工具在 preset 则在每个 `agent/created` 内于该 Agent scope 注册 `ops_*` 并就地掩码。外部已提供 OPS 时零注册复用；冻结工具映射表 | 开启 |
| 流式层 | 监听 `llm/stream`，只在 `reasoning-delta` 上检测复读 / 自指打转；命中即丢弃后续推理增量，并把 `block-end` 替换为截断版（落盘的是截断版） | 开启 |
| 执行层 | 注册静态批量建议段 `dsh-efficiency-orchestrator:batch-policy`（order `9550–9599`），段内工具名在每次组装时按 Agent 实时解析；压缩后的下一次 `pre-step` 插入一条 ≤80 字符 notice | **批量段默认关闭** |
| 会话层 | 注册静态预算段 `dsh-efficiency-orchestrator:session-budget`（order `9700`），按计数器状态条件渲染提醒；支持硬停止与降级强提醒 | 段开启、预算默认不触发 |

## 工具层：双路径 OPS 接管

### 两种组合形态

| 官方工具位置 | 本插件动作 | 掩码方式 |
|---|---|---|
| Profile 层（TUI / headless） | 在 profile scope 一次性注册 `ops_*`，别名捕获 profile 视图里的官方定义 | 对每个 Agent 调用 `agent.ctx.tools.restrict({ deny: [official] })` |
| Agent preset 层（Web / Desktop） | 在 `agent/created` 里，从**该 Agent 的视图**取官方定义，并在 `agent.ctx` 的 scope 注册 `ops_*` | 在同一 `agent.ctx` scope 内 `restrict()`，只隐藏该 Agent 能看到的那一份 |

### 一次接管的六条不变量

1. **只读探测，零试错注册。** 先 `get()` / `definitions()` 查询，绝不注册一个"探针"
   工具再撤销；检测到外部 OPS 提供者（如 `dsh-ops/integration`）时**不注册、不掩码**，
   直接复用。
2. **按 Agent 判定可见性。** "这个 Agent 能不能看到官方工具"始终以该 Agent 为 scope
   查询，不用 profile 全局视图推断；看不到就不发布，避免给没有 read 的 preset 硬塞别名。
3. **先掩码、后注册、失败即回滚。** 官方名先 `restrict()`；别名注册失败或自校验失败，
   立刻撤销别名并抬起掩码——**替换永远不会让某个 Agent 少一个能力**。
4. **注册后自校验。** 别名必须在该 Agent 可见、官方名必须已不可见；任一条件不满足即
   回滚并告警，而不是静默留下一个"看起来已接管"的假象。
5. **查询带显式 scope。** `get()` / `definitions()` 的 viewing scope 是**参数**，不是
   `this.ctx`；`register()` / `restrict()` 才通过 traceable 上下文绑定 scope。两者混用
   会让 preset 作用域查询退化回 profile 视图（正是本插件要修的故障模式）。
6. **生命周期自持。** per-Agent 的注册与掩码挂在 Agent fiber 上，不属于本插件；因此在
   `agent/disposed` 与插件卸载时都显式释放，重载不会留下残留掩码或残留工具。

### 时序

```
createAgent()
  ├─ setup(agentCtx, agent)        # preset 在此挂载：read/glob/grep 注册进 preset scope
  ├─ agents.enter(agent)           # 进入注册表，尚未 announced
  ├─ agents.announce()             # 串行派发 agent/created ← 本插件在此注册 + 掩码
  └─ 首次 turn → tools.resolve()   # 第一份工具声明已包含 ops_*、且不含官方 read/glob/grep
```

`agent/created` 是"preset 已就绪、模型尚未看到工具表"的唯一窗口；早于此看不到 preset 的
注册，晚于此第一份工具声明已经生成。插件激活时已存在的 Agent 通过 `agents.list()` 补做。

### 诊断

启用 `logLevel: debug` 时，工具层会留下可直接定位路径的日志：

- `profile scope exposes none of "read"/"glob"/"grep" … OPS publication runs inside each Agent scope`
  —— 识别为 preset 组合，进入 Agent 路径；
- `per-Agent OPS takeover: registered …, hid … for agent …` —— 每个 Agent 的接管结果；
- `forced replacement: official … hidden for agent …` —— profile 路径下的掩码结果；
- `OPS takeover could not replace an official tool …` —— 需要人介入的失败（已回滚，不丢能力）。

调度器状态（`tools`）同步记录 `per-Agent OPS takeover armed / active`，便于在
Plugins 面板与宿主诊断中确认当前路径。

## 兼容性

- DSH `0.2.2-rc.2`（`engines.dsh` 声明为 `^0.2.2-rc.2`）。
- Cordis `4.1.0`（`peerDependencies` 声明为 `~4.1.0`）。
- Node.js `>=20`（构建与运行时依赖 `node:crypto`，产物为 ES2022 ESM）。
- 运行时**零第三方依赖**；`@deepseek-ai/cordis` 只用于类型（`import type`）。

插件使用的 `ctx.tools` / `ctx.systemPrompt` / `ctx.on('agent/created')` /
`ctx.on('agent/pre-step')` / `ctx.on('session/event')` 等接口均为本地结构镜像
（见 `src/host.ts`），若未来 DSH 版本调整签名，编译错误会指向唯一需要更新的镜像处。

## 安装

本仓库**不发布到 npm**，`lib/` 是构建产物且不提交到 Git。请从源码构建后以本地目录安装：

```bash
npm install          # 安装构建期 devDependencies
npm run typecheck    # 可选
npm run build        # 产出 lib/index.js 与 lib/types/
```

然后二选一：

1. **Web / Desktop 插件面板**：Plugins → Add plugin → 选择本目录；
2. **DSH CLI**：`dsh plugin --profile <profile> add <本目录的绝对路径>`。

> 安装前请确认 `lib/index.js` 与 `lib/types/index.d.ts` 已存在；本地目录安装会直接解析
> `package.json#exports["."].default = ./lib/index.js`。

### 安装成功后可预期

- 插件 fiber 处于 `ACTIVE`，无 `live/failed-fiber`、无 `live/pending-missing-service`；
- 工具层二选一：复用外部 OPS 提供者，或自行接管——profile 组合下全局注册 OPS 别名并
  按 Agent 掩码；preset 组合下在 `agent/created` 内按 Agent 注册并掩码；
- 已接管的 Agent 视野里只有 `ops_inspect_local_file` / `ops_glob` / `ops_grep`，
  不再出现官方 `read` / `glob` / `grep`；
- 若启用批量段，系统提示词中出现 `dsh-efficiency-orchestrator:batch-policy`，并点名
  **该 Agent 当前实际可见**的只读工具（通常是 `ops_*`）；
- 会话预算段按会话层开关注册（没有预算参数时渲染为空）。

### 卸载 / 重载自检

禁用或移除插件后应回到安装前状态：profile 级 OPS 别名随插件 fiber 卸载；每个 Agent
上的 `ops_*` 注册与官方工具掩码被显式释放（`agent/disposed` 或卸载 teardown）；
系统提示词中不再出现 `dsh-efficiency-orchestrator:*` 段；`agent/created`、
`agent/pre-step`、`session/event`、`llm/stream` 监听器全部注销。重新启用会创建全新的
调度器实例，不会复用上一次加载的截断标记、压缩标记、预算状态或冻结映射表。

## 配置

插件没有导出 schemastery `Config`：Loader 会把 bundle 行的 `config` 原样传入，
插件在 `src/config.ts` 中自行归一化、钳制范围并忽略未知字段。示例：

```yaml
# cordis.patch.yml（或你在 profile 补丁中的覆盖行）
- insert:
    - id: dsh-efficiency-orchestrator
      name: 'dsh-efficiency-orchestrator'
      config:
        toolLayer:
          enabled: true
        streaming:
          enabled: true
        execution:
          enabled: true
          batch:
            enabled: true      # 默认 false：不启用就不注册段
            order: 9550        # 钳制在 9550–9599
            maxToolHints: 4    # 段内最多点名几个当前可见工具
          notice: true         # 仅在批量段注册成功时生效
        session:
          enabled: true
          hardStop: false      # 超预算时是否 reject 步骤（需宿主支持）
          fallbackStepLimit: 0 # 0 = 自建计数器永不触发；>0 才启用
          warnWithin: 2        # 距上限几步开始渲染提醒
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolLayer.enabled` | `true` | 关闭后不探测、不注册、不掩码、不冻结映射表 |
| `streaming.enabled` | `true` | 关闭后不挂 `llm/stream` 监听 |
| `execution.enabled` | `true` | 关闭后不挂执行层（批量段与 notice 均不生效） |
| `execution.batch.enabled` | `false` | 批量建议段开关（显式开启才注册） |
| `execution.batch.order` | `9550` | 钳制到 `9550–9599` |
| `execution.batch.maxToolHints` | `4` | 段内可点名的工具数量（`0–12`） |
| `execution.notice` | `true` | 压缩后 notice（依赖批量段已注册） |
| `session.enabled` | `true` | 会话预算段开关 |
| `session.hardStop` | `false` | 超预算时是否尝试 `{ kind: 'reject' }` |
| `session.fallbackStepLimit` | `0` | 外部预算不可用时的自建步数上限；`0` = 永不触发 |
| `session.warnWithin` | `2` | 剩余步数 / 轮数 ≤ 此值时渲染提醒 |

## 行为与安全边界

- **工具层接管绝不丢能力。** 本插件只注册唯一的 `ops_*` id，绝不覆盖官方 id，因此不会
  产生 `live/tool-id-conflict`；同一官方名在多 scope 中由 nearest-scope 规则自然遮蔽。
  掩码严格后置于可见性判定，且"先掩码、后注册、失败回滚 + 注册后自校验"：只有当别名
  在该 Agent 确认可见时，官方名才会被隐藏。宿主缺少 Agent 作用域注册面或 `agent.ctx`
  时，记录一次诊断并保留官方工具可见，OPS 侧不会强行注册。
- **只读探测，不做试错注册。** 工具层用 `ctx.tools.get()` / `definitions()` 查询；
  外部已提供 OPS 工具时零注册调用。profile 级注册发生冲突时回滚本次尝试并让位，
  **不重试**。
- **批量段按 Agent 解析。** 段文本在每次组装时用该 Agent 的 scope 查询可见的只读工具，
  因此 Web 端会点名 `ops_*`，TUI 端会点名官方名；冻结映射表只在"没有 Agent 上下文"的
  预览场景兜底。
- **批量段的安全默认。** 仅在配置显式启用、工具映射表已冻结、且只读
  `systemPrompt.assemble()` 能确认不存在 `batch-tool-calls:policy` 时才注册；
  无法确认时宁可不注册并记录诊断。notice 同样以"段已注册 + notice 开启"为前提。
- **推断截断以落盘为准。** 流式层命中后只影响 `reasoning` 块：丢弃其后续增量，并把
  `block-end` 的 `block.text` 替换为截断版；正文与工具调用增量原样透传。内部检测异常
  只关闭该条流的检测，不阻断模型流。
- **压缩后 notice。** `compaction/end` 是 session 日志事件（通过 `session/event`
  观察）。同一次压缩至多一条 notice，长度上限 80 字符；插入失败会清除标记并记录诊断，
  不重试。notice 以插件自有 source（`form: 'notice'`）注入，不伪装成用户输入。
- **会话预算。** 仅软探测 `settings.describe()` / `configEditor.configuration()` /
  `agentPresets.list()` 中显式声明的 `turnLimit` 类字段；**不读取、也不声称读取
  `dsh-flash-presets` 的预算**。读不到就退化为自建步数计数器（默认不触发）。
  硬停止能力在启动时探测；不支持时降级为段内强提醒，并在调度器状态中记录已超限。
- **不发布任何服务**；`ctx.on` / `ctx.tools.register` / `ctx.systemPrompt.section`
  是 Cordis effect，随插件 fiber 卸载自动撤销；per-Agent 的 `ctx.tools.register()` 与
  `ctx.tools.restrict()` 由本插件在 `agent/disposed` 与调度器 teardown 中显式撤销。
  自建资源（流式 buffer、会话计数器、注册簿记、Agent 接管 disposer）统一由调度器
  `ResourceManager` 串行逆序清理；根 effect 的 disposer 会等待异步挂载完成后再清理。

## 架构

```
apply(ctx, config)
└─ ctx.effect(...)                       # 唯一根 effect + 唯一 disposer
   └─ OrchestratorScheduler.start()
      ├─ ToolLayer        # 探测 profile 视图，二选一：
      │                   #   ├─ 官方工具在 profile → 全局注册 ops_* + 按 Agent 掩码
      │                   #   └─ 官方工具在 preset  → agent/created 内按 Agent 注册 + 掩码
      ├─ StreamingLayer   # llm/stream：reasoning-delta 检测 → 截断 block-end
      ├─ ExecutionLayer   # 批量段（按 Agent 实时解析工具 id）+ compression notice
      └─ SessionLayer     # 预算段（条件渲染）+ 计数器/硬停止
```

- **挂载顺序即因果顺序**：工具层先完成接管并在 profile 路径下冻结映射表，执行层才允许
  注册批量段；执行层在 `pre-step` 中先消费"已截断推理"标记，再判断是否插入 notice。
- **两条路径，一套不变量**：无论别名注册在 profile 还是 Agent scope，判定、掩码、回滚、
  自校验、释放的规则完全相同，因此行为不随组合形态漂移。
- **调度器是唯一状态拥有者**：`truncatedSessions`、`compactionPending`、
  `budgetExceeded`、`frozenToolMap` 与 Agent 接管表都挂在调度器/工具层实例上，卸载时
  统一清理；新一次加载会创建全新实例，不会读到上一次加载的脏状态。
- **生命周期竞态防护**：异步挂载（只读 `assemble()` 探测）期间若发生卸载，
  `stop()` 会等待挂载链结束，各层在 `await` 之后复查 `isRunning()`，
  不会在卸载开始后注册新的 effect。

## 开发

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> lib/
npm pack --dry-run   # 查看将被打包的文件
```

- `lib/`、`node_modules/` 已在 `.gitignore` 中忽略；`lib/` 必须在安装前构建。
- 源码为 ES2022 ESM，`verbatimModuleSyntax` + `isolatedModules` 开启，
  所有相对导入都带 `.js` 扩展名（NodeNext 规则）。
- 建议在提交前运行 `npm run typecheck`；CI（GitHub Actions）会执行
  `npm install && npm run typecheck && npm run build && npm pack --dry-run`。

### 目录结构

```
.
├─ package.json
├─ tsconfig.json
├─ cordis.patch.yml
├─ src/
│  ├─ index.ts                  # 入口 + OrchestratorScheduler + ResourceManager
│  ├─ config.ts                 # 配置归一化与 section 常量
│  ├─ types.ts                  # 调度器词汇 / SchedulerHost
│  ├─ host.ts                   # Host 契约的本地结构镜像（含 scope 查询契约）
│  ├─ notice.ts                 # 压缩后 notice 消息
│  ├─ tool-layer.ts             # 工具层：双路径 OPS 接管
│  ├─ streaming-layer.ts        # 流式熔断层
│  ├─ reasoning-loop-detector.ts# 纯检测内核
│  ├─ execution-layer.ts        # 执行层
│  └─ session-layer.ts          # 会话预算层
└─ lib/                         # npm run build 生成，不入库
```

## 已知限制

- **中文提示文本**：内置的批量建议段与预算段文案为中文；工具 ID、配置键为英文。
- **硬编码三对工具。** 接管范围固定为 `read ↔ ops_inspect_local_file`、
  `glob ↔ ops_glob`、`grep ↔ ops_grep`（`OPS_TOOL_PAIRS`）；新增工具需要同时扩展该表
  与 `aliasDefinition` 的透传字段。
- **依赖 Agent 生命周期契约。** Agent 路径要求宿主提供 `agent.ctx`、`agent.created`
  序列事件与带 scope 的 `tools.get()`（当前验证版本满足）。降级宿主的处理：profile
  路径照常工作；Agent 路径记录诊断并保留官方工具可见，绝不因此让 fiber 失败。
- **preset 热切换的边界。** 别名在 `agent/created` 时捕获当次 preset revision 的官方
  定义；对空白会话执行 preset 切换后，已注册别名仍指向旧 revision 的 `execute`，
  直到该 Agent 重建。常规会话不会触发该路径。
- **批量段注册条件较保守**：若只读 `systemPrompt.assemble()` 不可用或抛错，按安全默认
  不注册，并在日志中记录 "cannot confirm … conflict"。此时可先排查 profile 的
  工具执行器是否已挂载。
- **硬停止语义**：启用 `session.hardStop` 且预算超限后，该会话后续 `pre-step`
  会持续被拒绝，直到会话预算状态被重置（新会话或插件重载）。这是"硬停止"的预期
  语义，不需要时请保持 `hardStop: false`。
- **压缩 notice**：依赖宿主把 `compaction/end` 写入 session 日志；若当前 profile
  没有压缩插件或该日志事件，notice 通道静默不生效（不影响批量段）。
- **外部预算探测是启发式**：会在 `settings` / `configEditor` / `agentPresets` 的可读配置中
  按 `turnLimit`、`maxTurns`、`maxUserTurns`、`maxRounds`、`roundLimit` 键名匹配；若其他
  插件恰好使用同名字段，可能被当作显式轮数上限。介意时请关闭 `session` 层，或避免在 profile
  配置中使用这些键名作为无关字段。
- **与外部 OPS 提供者共存**：检测到 `ops_inspect_local_file` / `ops_glob` / `ops_grep`
  已被解析时，本插件零注册、零掩码，替换语义完全交给外部实现。
- **未包含 UI / 设置页**：配置通过 bundle 行传入；插件不注册任何 Web 路由或客户端模块。

## 致谢与参考

本插件的设计与以下社区项目/规范相关，特此致谢（均为 MIT 许可或公开语义参考）：

- [dsh-no-loop-plugin](https://github.com/54nanmiao/dsh-no-loop-plugin) —— 流式推理
  熔断的信号模型（ritual / recycle / tail 与三档阈值），以及"block-end 必须落盘截断版"的关键经验。
- [dsh-batch-tool-calls](https://github.com/liancha22/dsh-batch-tool-calls) ——
  静态提示段的定位（order 9500 一带）与"压缩后下一次 pre-step 插一条 notice"的通道设计。
- [dsh-ops](https://github.com/T-Auto/dsh-ops) —— OPS 工具命名与
  "仅当 OPS counterpart 可见时才隐藏官方工具"的替换语义。

> 本项目的检测器为独立 TypeScript 实现（并非上游源码的逐字拷贝），
> 但信号模型受上述项目启发；若你继续分发本项目，请保留本节的致谢信息。

## License

[MIT](./LICENSE) © 2026 dsh-efficiency-orchestrator contributors
