# pi-qqbot 终端对话过程可见性开发计划书

> 文档状态：已确认并完成首轮实现（2026-07-14）  
> 项目基线：`pi-qqbot` v0.2.1（commit `9ce0f66`）  
> 目标环境：当前已安装的 `@earendil-works/pi-coding-agent` v0.80.2  
> 目标主题：让 QQ 对话过程只显示在执行 `/qqbot-start` 的 Pi TUI 终端中，同时继续保持 QQ AgentSession 与本地 Pi 会话上下文隔离。

---

## 1. 目标摘要

在不破坏 v0.2.1 已有功能的前提下，为 QQ 专用的隔离 AgentSession 增加一个**进程内、TUI 专属、非持久化**的对话观察视图：

1. 用户在某个 Pi TUI 终端执行 `/qqbot-start` 后，该终端成为本进程 QQBot 的“显示终端”。
2. 该终端实时看到：
   - 已授权的 QQ 入站文本；
   - 排队与开始处理状态；
   - Assistant 的可见文本流；
   - 工具调用开始、结束与成功/失败状态；
   - QQ 回复发送结果与运行错误。
3. 未执行 `/qqbot-start` 的其他 Pi 终端不显示上述 QQ 对话内容。
4. QQ 对话仍由独立的 `AgentSession` 处理，不注入本地 Pi 对话，不参与本地模型上下文，不写入本地 Pi 会话 JSONL。
5. 本迭代不把模型隐藏思考内容、完整工具输出或无限历史记录暴露到终端。

---

## 2. 已完成的项目审阅

### 2.1 当前代码结构

| 文件 | 当前职责 | 与本需求的关系 |
|---|---|---|
| `index.ts` | 注册 `/qqbot-*` 命令；读取配置；创建/停止 `PiQQBotRuntime`；在 `session_shutdown` 清理 | `/qqbot-start` 的命令 `ctx` 是绑定显示终端的唯一可靠入口 |
| `router.ts` | allowlist、QQ 命令、FIFO 队列、隔离会话调用、QQ 回复发送、状态与摘要 | 需要在这里把 QQ 消息生命周期映射成终端展示事件 |
| `qq-session.ts` | 动态加载 Pi SDK；创建 `noExtensions: true` 的独立内存 `AgentSession`；订阅工具与 `agent_end` 事件 | 需要扩展为订阅 `message_update`，向上报告文本流和工具生命周期 |
| `queue.ts` | 单 FIFO 队列 | 保持不变；展示层只观察，不改变队列调度 |
| `qq-gateway.ts` | QQ WebSocket、心跳、重连、消息标准化 | 不应承载 TUI 逻辑，原则上保持不变 |
| `qq-api.ts` | QQ 被动回复接口与分片发送 | 只需要由 `router.ts` 报告发送状态，API 本身保持不变 |
| `config.ts` / `types.ts` | 配置默认值、校验、公共类型 | 本迭代原则上不增加配置开关；可在 `types.ts` 增加观察事件类型 |

### 2.2 当前运行链路

```text
QQ Gateway
  -> PiQQBotRuntime.handleInbound()
  -> allowlist / QQ 命令判断
  -> MessageQueue
  -> PiQQBotRuntime.runOne()
  -> QQAgentSession.run()
  -> 独立 AgentSession.prompt()
  -> 收集最终 Assistant 文本和工具摘要
  -> PiQQBotRuntime.deliverReply()
  -> QQ API 被动回复
```

### 2.3 当前隔离机制

当前 v0.2.1 已经具备正确的会话隔离基础：

- `QQAgentSession` 使用 `SessionManager.inMemory(cwd)`；
- `DefaultResourceLoader` 设置 `noExtensions: true`，避免递归加载 `pi-qqbot`；
- QQ 输入不再调用本地会话的 `pi.sendUserMessage()`；
- QQ 会话与本地 Pi TUI 会话可以并行运行；
- `session_shutdown` 会停止网关并释放隔离会话。

本迭代必须保留这些约束，不能为了“显示对话”退回到把 QQ 消息注入本地会话的旧方案。

### 2.4 当前可见性缺口

`QQAgentSession.run()` 目前只收集：

- `tool_execution_start`；
- `tool_execution_end`；
- `agent_end`。

它没有把 `message_update` 中的 `text_delta` 传给宿主 TUI，因此本地终端看不到 Assistant 的实时输出。`router.ts` 也没有独立的 TUI 观察层。

### 2.5 发现的关联正确性问题

当前工具结束事件通过 `tools[tools.length - 1]` 标记成功/失败。在 Pi 默认并行工具模式下，`tool_execution_end` 按完成顺序到达，不保证与开始顺序一致，因此可能把错误状态标到错误工具上。

本需求要展示真实工具过程，实施时必须一并改为使用 `toolCallId` 做关联；这是实现可见过程的必要正确性修复，而不是无关扩展。

---

## 3. 已参考的 Pi 官方资料

本计划以本机安装包内的官方文档和示例为实现依据：

1. `docs/extensions.md`
   - 后台 socket、timer、会话等长生命周期资源应在 `session_start` 或命令中创建，并在 `session_shutdown` 幂等释放；
   - `ctx.mode === "tui"` 才应启用 TUI 专属功能；
   - `ctx.ui.setStatus()`、`ctx.ui.setWidget()`、`ctx.ui.notify()` 是扩展的官方 UI 入口；
   - `pi.sendMessage()` 会向当前会话注入自定义消息，不适合作为纯观察视图。
2. `docs/sdk.md`
   - `AgentSession.subscribe()` 可接收 `message_update`、工具执行和 `agent_end` 等事件；
   - `message_update.assistantMessageEvent.type === "text_delta"` 可获取 Assistant 可见文本流；
   - 会话结束必须 `dispose()`。
3. `docs/tui.md`
   - Widget 适合编辑器上方/下方的持续状态与进度展示；
   - 自定义组件的每一行不得超过 `render(width)` 给定宽度；
   - 状态改变后必须触发重新渲染；
   - 应使用 `truncateToWidth()` / `wrapTextWithAnsi()` 处理终端宽度；
   - 组件应正确实现 `invalidate()`。
4. `docs/session-format.md`
   - `CustomMessageEntry` 会参与本地 LLM 上下文并持久化；因此本迭代不使用 `pi.sendMessage()` 来显示 QQ 对话。
5. 官方示例
   - `examples/sdk/01-minimal.ts`：订阅 `text_delta`；
   - `examples/extensions/widget-placement.ts`：Widget 用法；
   - `examples/extensions/status-line.ts`：扩展状态栏；
   - `examples/extensions/message-renderer.ts`：自定义消息渲染。该方案已审阅，但因会话污染风险不采用。

当前 Pi 交互模式实现对扩展 Widget 有 10 行上限，因此本计划把终端视图明确限定为“实时尾部窗口”，而不是无限滚动日志。

---

## 4. 需求解释与验收边界

### 4.1 “只能在执行 `/qqbot-start` 的终端展示”的精确定义

以**操作系统进程内所有权**作为边界：

- 每个 Pi 终端是独立进程，分别加载自己的扩展实例和模块状态；
- 终端视图只能由该进程内 `/qqbot-start` 命令收到的 `ExtensionCommandContext` 创建；
- 不通过文件、共享 socket、全局 EventBus、stdout 广播或其他 IPC 把展示事件发送给别的 Pi 进程；
- 其他 Pi 终端即使也加载了扩展，只要没有在该终端执行 `/qqbot-start`，就没有终端观察器，不显示 QQ 入站文本、Assistant 输出或工具过程；
- `/qqbot-stop`、`/reload`、`/new`、`/resume`、`/fork` 或退出触发 `session_shutdown` 后，所有权立即失效并清理视图。

### 4.2 `autoStart` 的限定行为

为了满足“由 `/qqbot-start` 明确选择显示终端”：

- `autoStart: true` 可以继续保留现有自动连接能力，但**自动启动本身不附加终端对话视图**；
- 如果某进程已经由 `autoStart` 启动，再在该终端执行 `/qqbot-start`，命令不只返回“already running”，还应把该终端附加为显示终端；
- 默认配置仍保持 `autoStart: false`；
- 多进程同时自动连接同一个 QQBot 网关的竞争问题不在本迭代解决范围内；推荐验收配置为 `autoStart: false`。

### 4.3 “对话过程”的本迭代范围

包括：

- 已授权 QQ 用户/群的入站文本；
- QQ 侧内置命令的入站与直接回复；
- FIFO 排队深度、开始处理；
- Assistant 可见文本的流式增量；
- 工具名、关键参数的一行摘要、开始与结束状态；
- 最终回复准备、QQ 分片数、发送成功/失败；
- 会话初始化、模型调用和发送错误。

不包括：

- 模型隐藏 thinking / chain-of-thought；
- 工具完整 stdout、完整文件内容或完整工具结果；
- 未授权用户的消息正文；
- 永久保存的完整终端聊天历史；
- 在其他 Pi 终端同步查看；
- 从终端视图反向操作 QQ 会话。

### 4.4 本地会话“不受影响”的定义

- 不调用本地会话的 `pi.sendUserMessage()`；
- 不调用用于展示的 `pi.sendMessage()`；
- 不为终端镜像调用 `pi.appendEntry()`；
- 不把 QQ 镜像事件加入 `ctx.sessionManager`；
- 不修改本地 Agent 的消息、工具、模型、thinking level 或 system prompt；
- Widget 不抢占输入焦点，本地编辑器和本地 Agent 仍可正常使用。

---

## 5. 方案比较与结论

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `pi.sendUserMessage()` 注入本地会话 | 自动获得原生用户/Assistant/TUI 渲染 | 破坏隔离、打断本地会话、污染上下文 | 禁止 |
| `pi.sendMessage({display:true})` + 自定义 renderer | 能进入聊天区并使用漂亮渲染 | 自定义消息会持久化并参与本地上下文；会话树被污染 | 不采用 |
| 直接 `process.stdout.write()` | SDK 示例简单、流式自然 | 会破坏 Pi TUI ANSI 渲染，绕过官方 UI 生命周期 | 禁止 |
| `ctx.ui.custom()` / Overlay | 可做复杂界面 | 会抢占焦点或覆盖编辑器，不适合后台持续对话 | 不采用 |
| 仅 `ctx.ui.notify()` | 不进入 LLM 上下文 | 连续状态可能合并，token 级更新会闪烁和刷屏 | 只用于少量错误/确认，不作为主视图 |
| `ctx.ui.setWidget()` + `setStatus()` | 官方 API、进程内、非持久化、不抢焦点、可实时更新 | 可见行数有限，需要节流和截断 | **采用** |

### 5.1 最终设计

采用“**状态栏 + 实时尾部 Widget**”双层展示：

- Footer status：连接状态、队列长度、当前是否运行；
- Widget：最近一段 QQ 对话过程，最多 10 个渲染行；
- 错误和启动/停止结果仍可使用现有 `notify()`；
- Widget 保留当前/最近过程直到下一条消息或 `/qqbot-stop`，不写入会话文件。

---

## 6. 目标架构

```text
                       当前 Pi 进程（终端 A）
┌────────────────────────────────────────────────────────────┐
│ /qqbot-start(ctx-A)                                        │
│   ├─ 创建/取得 PiQQBotRuntime                              │
│   └─ 创建 TerminalConversationView(ctx-A)                  │
│                         ▲                                   │
│                         │ QQTerminalEvent                   │
│ QQ Gateway -> Router -> QQAgentSession.subscribe()          │
│                         │                                   │
│                         ├─ text_delta                       │
│                         ├─ tool start/end                   │
│                         └─ agent end/error                  │
│                                                             │
│ TerminalConversationView                                    │
│   ├─ ctx-A.ui.setStatus("pi-qqbot", ...)                   │
│   └─ ctx-A.ui.setWidget("pi-qqbot-conversation", ...)      │
└────────────────────────────────────────────────────────────┘

                       其他 Pi 进程（终端 B）
┌────────────────────────────────────────────────────────────┐
│ 已加载 pi-qqbot，但未执行 /qqbot-start                      │
│   └─ 不创建 TerminalConversationView                        │
│      不接收、不渲染终端 A 的 QQTerminalEvent                │
└────────────────────────────────────────────────────────────┘
```

关键点：QQ AgentSession 仍然是独立会话；新增的是旁路观察通道，而不是消息路由通道。

---

## 7. 事件契约设计

建议在 `types.ts` 中增加仅供进程内使用的判别联合类型：

```ts
type QQTerminalEvent =
  | { kind: "inbound"; messageId: string; channel: "private" | "group"; senderLabel: string; text: string; at: number }
  | { kind: "queued"; messageId: string; queueSize: number; at: number }
  | { kind: "run_start"; messageId: string; at: number }
  | { kind: "assistant_delta"; messageId: string; delta: string; at: number }
  | { kind: "tool_start"; messageId: string; toolCallId: string; toolName: string; args: unknown; at: number }
  | { kind: "tool_end"; messageId: string; toolCallId: string; toolName: string; isError: boolean; at: number }
  | { kind: "reply_start"; messageId: string; chunks: number; fake: boolean; at: number }
  | { kind: "reply_end"; messageId: string; ok: boolean; error?: string; at: number }
  | { kind: "run_end"; messageId: string; at: number }
  | { kind: "error"; messageId?: string; stage: string; message: string; at: number };
```

观察器接口：

```ts
interface QQConversationObserver {
  onEvent(event: QQTerminalEvent): void;
  dispose(): void;
}
```

约束：

- 观察器是可选依赖；没有观察器时，现有 QQ 功能必须完全照常工作；
- 事件发布不得 `await` TUI，避免 UI 阻塞 QQ 回复；
- 观察器异常必须在边界处捕获，不能使 Agent 或 QQ 回复失败；
- 所有事件使用 `messageId` 关联，工具使用 `toolCallId` 关联；
- 不把 `ExtensionContext` 传进 `QQAgentSession`，保持 SDK 会话层与 TUI 解耦。

---

## 8. 终端视图规格

### 8.1 默认展示格式

示意：

```text
QQBot ● connected | queue 1 | processing private:FC9A…F8FD
QQ 12:01  请查看当前目录
↳ queued (1)
Pi 12:01  我先检查目录内容…
🔧 bash  ls -la                              running
✓ bash                                      done
Pi 12:01  当前目录包含……
↗ QQ reply                                  sent (1 chunk)
```

### 8.2 数据与渲染上限

为避免 TUI 性能下降和敏感输出扩散，建议固定以下边界：

| 项目 | 上限/策略 |
|---|---|
| Widget 渲染行数 | 最多 10 行，与当前 Pi 交互模式上限一致 |
| 内存事件数 | 最近 40 个结构化事件 |
| Assistant 流式缓存 | 每条运行最多保留 8,000 字符，超出保留尾部并显示截断标记 |
| 工具参数摘要 | 单行、去控制字符/换行、最多 120 字符 |
| 入站消息展示 | Widget 中按终端宽度换行；内存最多保留 2,000 字符 |
| UI 刷新节流 | `text_delta` 最多每 80ms 刷新一次；结束事件立即 flush |
| 身份显示 | 默认使用缩略 openid，不在 Widget 展示完整 openid |

这些限制只影响终端镜像，不改变发送给隔离 AgentSession 的 prompt，也不改变最终 QQ 回复内容。

### 8.3 TUI 组件要求

- 新建非交互、不可聚焦的 Widget 组件；
- `render(width)` 返回的每行可见宽度不得超过 `width`；
- 使用 Pi TUI 官方工具做 ANSI 安全截断/换行；
- 状态变更后调用 `tui.requestRender()`；
- `invalidate()` 清除渲染缓存，颜色在 render 阶段按当前 theme 生成；
- 不使用 Overlay，不注册键盘输入，不替换编辑器。

### 8.4 thinking 与工具输出策略

- 只显示 `text_delta`，不显示 `thinking_delta`；
- 工具只显示名称、关键参数摘要、成功/失败；
- `tool_execution_update.partialResult` 本迭代不显示，防止大输出拖垮 TUI；
- 最终 Assistant 文本不再重复整段追加一次，以流式缓存的最终状态为准。

---

## 9. 文件级实施计划

### 9.1 新增 `terminal-view.ts`

职责：

- 实现 `TerminalConversationView`；
- 维护结构化事件环形缓冲、Assistant 增量缓存和工具状态；
- 安装/更新 `setStatus` 与 `setWidget`；
- 负责节流、终端宽度处理、openid 缩略和控制字符清理；
- `dispose()` 时清 timer、清 Widget、清 status，并设置 disposed guard，拒绝迟到事件。

不承担：

- QQ 网关、鉴权、队列或回复发送；
- AgentSession 创建；
- 会话持久化。

### 9.2 修改 `types.ts`

- 增加 `QQTerminalEvent` 与 `QQConversationObserver`；
- 如需要，为 start 来源增加 `"command" | "auto"` 类型；
- 不增加用户配置字段。

### 9.3 修改 `qq-session.ts`

- `QQAgentSession.run()` 接收可选的本次运行事件回调或观察器；
- 订阅 `message_update`，仅处理 `text_delta`；
- 工具记录增加 `toolCallId`；
- 使用 `Map<toolCallId, index/state>` 正确关联并行工具的结束状态；
- 继续通过 `agent_end` 提取最终文本，保证 QQ 回复逻辑不依赖终端流是否完整；
- `finally` 中始终取消订阅；
- 观察器异常隔离，不影响 `session.prompt()`。

### 9.4 修改 `router.ts`

- 把 `ExtensionAPI` 从 Runtime 中移除或不再保存（当前字段未实际使用）；
- 增加可选观察器的 attach/detach 方法；
- 在以下位置发送结构化事件：
  - allowlist 通过且消息非空后：`inbound`；
  - 入队后：`queued`；
  - `runOne()` 开始/结束；
  - 从 `QQAgentSession` 转发 Assistant 与工具事件；
  - `deliverReply()` 开始、成功和失败；
  - 隔离会话初始化/运行异常；
- QQ 侧 `/qqbot-status` 等直接命令也记录入站与回包状态；
- 未授权消息正文不进入观察器；
- `stop()` 先 detach 观察器，再关闭资源，防止迟到事件写到已失效的 TUI。

### 9.5 修改 `index.ts`

- `/qqbot-start` 成为“启动或附加显示终端”的幂等命令：
  1. 校验配置；
  2. 仅当 `ctx.mode === "tui"` 时创建 `TerminalConversationView`；
  3. Runtime 不存在时创建并启动；
  4. Runtime 已由 autoStart 或先前流程启动时，将当前命令终端附加为显示终端；
  5. 同一进程重复执行时不创建重复 Widget/订阅。
- `autoStart` 只启动 Runtime，不自动创建终端对话视图；
- `/qqbot-stop` 清理 Runtime 和视图；
- `session_shutdown` 做相同的幂等清理；
- 对非 TUI 模式给出简短提示，但不启用 Widget；
- 为 `starting/running/stopping` 增加最小状态保护，避免重复 start 竞态；
- 修复隔离会话初始化失败后 Runtime 仍被误认为“running”的状态表达，可采用明确 `StartResult` 或 `isReady()` 判断。

### 9.6 修改 `README.md`

仅更新与本功能直接相关内容：

- `/qqbot-start` 同时选择当前 Pi TUI 为对话显示终端；
- 显示内容与 10 行尾部窗口限制；
- QQ 会话仍然独立，不进入本地上下文；
- `autoStart` 不自动附加对话视图；
- 多终端行为示例；
- 不显示 thinking 和完整工具输出。

### 9.7 原则上不修改的文件

- `qq-auth.ts`；
- `qq-gateway.ts`；
- `qq-api.ts`；
- `queue.ts`；
- `pi-qqbot.json.example`（因为不新增配置）；
- `package.json` 依赖（优先使用 Pi 官方已提供的 TUI API，不引入第三方库）。

---

## 10. 生命周期与状态机

### 10.1 进程内状态

```text
STOPPED
  └─ /qqbot-start -> STARTING
       ├─ 初始化成功 -> RUNNING + VIEW_ATTACHED
       └─ 初始化失败 -> STOPPED + VIEW_DISPOSED

RUNNING + NO_VIEW        （仅可能来自 autoStart）
  └─ /qqbot-start -> RUNNING + VIEW_ATTACHED

RUNNING + VIEW_ATTACHED
  ├─ 再次 /qqbot-start -> 幂等，保持单一 view
  ├─ /qqbot-stop -> STOPPING -> STOPPED
  └─ session_shutdown -> STOPPING -> STOPPED
```

### 10.2 所有权规则

- 一个扩展进程最多一个 Runtime、一个终端视图；
- 视图只引用本进程命令上下文；
- 同一进程发生 session replacement 时不迁移旧 `ctx`，而是停止 Runtime；
- 若未来要在新会话继续运行，必须由用户在新会话重新执行 `/qqbot-start`；
- 任何异步回调都检查 runtime generation/disposed 标记，防止 reload 后旧回调更新新界面。

---

## 11. 分阶段开发安排

### 阶段 0：基线冻结与验收样例准备（0.25 人日）

任务：

- 记录 v0.2.1 基线行为；
- 使用 `/qqbot-status`、`/qqbot-fake` 验证当前隔离会话正常；
- 明确测试时使用 `autoStart: false`；
- 保证工作树干净。

退出条件：

- 现有启动、停止、fake、QQ 回复链路有可复现基线。

### 阶段 1：隔离会话事件化（0.5 人日）

任务：

- 定义观察事件契约；
- 在 `qq-session.ts` 采集 `text_delta` 和工具事件；
- 用 `toolCallId` 修复并行工具关联；
- 保持最终文本提取和 `showProcess` 兼容。

退出条件：

- 无观察器时行为与 v0.2.1 一致；
- 有观察器时事件顺序、messageId/toolCallId 可正确关联；
- 观察器抛错不影响最终 QQRunResult。

### 阶段 2：TUI 终端视图（0.75 人日）

任务：

- 实现 `TerminalConversationView`；
- 实现 10 行尾部渲染、节流、截断、主题失效处理；
- 实现 status + widget；
- 实现 dispose 和迟到事件保护。

退出条件：

- 本地输入编辑器不失焦；
- 长文本、中文宽字符、窄终端不会超过行宽；
- 高频 token 流不造成明显闪烁或卡顿。

### 阶段 3：命令所有权与 Runtime 接线（0.5 人日）

任务：

- `/qqbot-start` 创建或附加 view；
- `autoStart` 不附加 view；
- Router 发布入站、队列、运行、回复事件；
- `/qqbot-stop` 和 `session_shutdown` 完整清理；
- 处理初始化失败与重复 start 状态。

退出条件：

- 终端 A 执行 start 后可见；
- 终端 B 未执行 start 时不可见；
- stop/reload 后不再出现迟到输出。

### 阶段 4：回归、文档与发布准备（0.5 人日）

任务：

- 完成多终端手工验收矩阵；
- 验证真实 QQ 与 `/qqbot-fake`；
- 更新 README；
- 执行包内容检查；
- 是否升级版本号、打 tag、生成 tgz 必须另行确认，不在功能实现时自动执行。

退出条件：

- 完成第 12 节全部 P0/P1 用例；
- `git diff` 只包含计划内文件；
- 无真实凭据、token 或本地配置进入提交/包。

总工作量预估：约 2.5 人日，取决于真实 QQ 网关联调条件。

---

## 12. 测试与验收矩阵

### 12.1 P0：核心功能

| 编号 | 场景 | 操作 | 预期 |
|---|---|---|---|
| P0-01 | 单终端可见 | 终端 A `/qqbot-start`，QQ 发普通文本 | A 显示入站、Assistant 文本流、工具状态和回复结果 |
| P0-02 | 多终端隔离 | A 执行 start；B 只启动 Pi、不执行 start；QQ 发消息 | 仅 A 出现 QQ 对话正文和过程，B 不出现 |
| P0-03 | 本地会话隔离 | A 同时进行本地 Pi 对话和 QQ 对话 | 两者可并行；QQ 消息不进入本地 Agent 消息历史 |
| P0-04 | 不持久化 | 处理 QQ 消息前后检查本地 session entries | 不新增 QQ 镜像 custom/user/assistant entries |
| P0-05 | 停止清理 | 处理过程中或完成后 `/qqbot-stop` | Widget/status 被清理；后续迟到事件不再渲染 |
| P0-06 | 生命周期清理 | `/reload`、`/new` 或退出 | 旧 Runtime、timer、Widget、订阅全部释放 |
| P0-07 | QQ 回复不回归 | QQ 发消息 | 最终回复内容与分片规则仍按现有逻辑发送 |

### 12.2 P1：事件与边界

| 编号 | 场景 | 预期 |
|---|---|---|
| P1-01 | Assistant 长流式文本 | UI 约 80ms 节流；保留尾部；QQ 最终回复不被截断逻辑影响 |
| P1-02 | 多个并行工具 | 每个工具通过 `toolCallId` 获得正确成功/失败状态 |
| P1-03 | 工具异常 | Widget 显示失败；Agent 后续行为和 QQ 最终回复维持 Pi 原语义 |
| P1-04 | FIFO 多消息 | 顺序与现有队列一致；Widget 清楚显示 queued/processing |
| P1-05 | QQ 内置命令 | `/qqbot-status` 等入站与直接回复可见，不启动 Agent run |
| P1-06 | 未授权消息 | 不显示消息正文；不入队；不回复 |
| P1-07 | 空消息 | 不创建对话过程 |
| P1-08 | fake 消息 | A 可见完整过程；明确标识 fake；不调用 QQ API |
| P1-09 | autoStart | 自动连接后无对话 Widget；该终端执行 `/qqbot-start` 后附加 Widget |
| P1-10 | 非 TUI 模式 | 不创建 Widget，不调用 TUI 专属组件；QQ Runtime 行为不崩溃 |
| P1-11 | 网络/发送错误 | 错误只在所有者终端显示；队列可以继续处理下一条 |
| P1-12 | 窄终端与中文 | 所有渲染行不超过 width，无 ANSI/中文宽度破坏 |

### 12.3 双终端验收步骤

1. 设置 `autoStart: false`。
2. 打开终端 A 和终端 B，分别启动 Pi。
3. 两边执行 `/reload`，确认扩展都加载。
4. 仅在 A 执行 `/qqbot-start`。
5. 在 A 使用 `/qqbot-fake 请列出当前目录`，或从已授权 QQ 发送同类消息。
6. 观察 A：出现对话 Widget 和状态更新。
7. 观察 B：不得出现 QQ 消息正文、Assistant 流或工具过程。
8. 在 B 进行普通本地 Pi 对话，确认不受 A 的 QQ 运行影响。
9. 在 A 执行 `/qqbot-stop`，再次发消息，确认 A 不再更新。
10. 比较 A/B 本地 session entries，确认没有 QQ 镜像消息持久化。

### 12.4 包与安全检查

- `npm pack --dry-run` 检查包内容；
- 确认 `pi-qqbot.json`、`.env*`、token、真实 `clientSecret` 不进入 Git 或 tgz；
- 检查终端错误消息不包含 access token/clientSecret；
- 检查工具参数只做单行摘要，不显示完整结果。

当前项目没有现成自动化测试脚本。若实施时要新增测试框架或开发依赖，需单独确认；本迭代至少完成上述确定性的双终端手工验收。

---

## 13. 风险与控制措施

| 风险 | 影响 | 控制措施 |
|---|---|---|
| token 级刷新导致 TUI 卡顿 | 输入和渲染体验下降 | 80ms 节流，结束立即 flush，固定内存上限 |
| 使用 CustomMessage 污染本地上下文 | 本地 Agent 行为被 QQ 内容影响 | 明确禁止 `pi.sendMessage()`，只用 UI API |
| 旧命令 ctx 在 session replacement 后失效 | reload/new 后崩溃或串终端 | `session_shutdown` 先 dispose；generation/disposed guard |
| 并行工具完成乱序 | 错误状态显示到错误工具 | 全程使用 `toolCallId` 关联 |
| Widget 内容过长 | 占据屏幕或超过宽度 | 最大 10 行、环形缓冲、ANSI 安全截断 |
| 工具参数包含敏感数据 | 本地终端泄露 | 单行、截断、去控制字符；不显示完整工具结果 |
| 观察器异常阻断 QQ 回复 | QQ 用户收不到结果 | 观察器调用边界 try/catch，绝不 await UI |
| `/qqbot-stop` 后异步事件迟到 | 已停止界面继续更新 | 先 detach/dispose view，再释放 Agent/Gateway |
| autoStart 多进程网关竞争 | 多个进程争用 QQ 事件 | 本迭代不引入跨进程锁；验收使用 autoStart false，并在 README 说明 |
| 隔离会话初始化失败但 runtime 被视为运行中 | `/qqbot-start` 无法正确重试 | 引入明确 start 状态/结果，失败时回到 STOPPED |

---

## 14. 明确不做的事项

为控制范围，本迭代不做：

1. 跨 Pi 终端同步或远程查看；
2. 多进程 leader election、文件锁或 QQ 网关单实例守护进程；
3. QQ 多会话并发调度；继续使用单 FIFO；
4. 把 QQ 对话保存成独立 JSONL/数据库/日志文件；
5. 把 QQ 对话并入本地 Pi session；
6. 完整复刻 Pi 原生 Assistant/Tool 聊天组件；
7. 展示 chain-of-thought / thinking_delta；
8. 展示完整工具结果或实时 shell stdout；
9. 新增终端交互快捷键、滚动面板或 Overlay；
10. 修改 QQ 鉴权、网关协议、被动回复窗口和分片上限；
11. 自动升级 Pi SDK、添加第三方 UI 依赖；
12. 自动改版本号、打 Git tag、发布 npm/tgz。

如果后续需要“可滚动且完整的 QQ 对话历史”，应单独立项，优先考虑独立日志会话或 Pi 官方未来提供的 UI-only chat append API，而不是放宽本地会话隔离。

---

## 15. 完成定义（Definition of Done）

同时满足以下条件才算完成：

- [ ] 终端 A 执行 `/qqbot-start` 后可实时看到规定范围内的 QQ 对话过程；
- [ ] 未执行 `/qqbot-start` 的终端 B 看不到 QQ 对话内容；
- [ ] QQ 仍使用独立内存 AgentSession；
- [ ] 本地 session JSONL 不出现 QQ 镜像消息；
- [ ] 本地 Pi 对话可与 QQ 运行并行，输入焦点不被抢占；
- [ ] 并行工具通过 `toolCallId` 正确关联；
- [ ] `/qqbot-stop`、reload、session replacement、退出均无残留 Widget/timer/subscription；
- [ ] 高频文本流、长文本、窄终端和中文渲染通过测试；
- [ ] 现有 allowlist、QQ 命令、队列、showProcess、被动回复、fake 调试无回归；
- [ ] README 与实际行为一致；
- [ ] 无真实凭据进入 Git diff 或发布包。

---

## 16. 回滚策略

该设计通过可选观察器与独立 `terminal-view.ts` 实现，回滚边界清晰：

1. 移除 `index.ts` 的 view 创建/附加逻辑；
2. 移除 `router.ts` 的观察事件发布；
3. 保留 `toolCallId` 正确性修复也不会改变正常 QQ 回复语义；
4. 删除 `terminal-view.ts` 和相应类型；
5. QQ Gateway、API、队列与隔离 AgentSession 主链路仍可恢复到 v0.2.1 行为。

若上线后仅 TUI 展示出现问题，可先禁用观察器而不停止 QQBot 核心收发。

---

## 17. 实施前确认基线

本计划建议以以下默认决策进入编码：

1. 主视图采用编辑器上方、最多 10 行的实时尾部 Widget；
2. `/qqbot-start` 即为显示授权，不新增 `terminalDisplay` 配置项；
3. `autoStart` 只连接、不自动显示；在该终端手动执行 `/qqbot-start` 可附加显示；
4. 不显示 thinking 和完整工具输出；
5. 不持久化终端镜像历史；
6. 不在本迭代引入跨进程锁；多终端验收使用 `autoStart: false`。

只有本计划确认后才进入代码修改阶段。
