# Agent Note: Teammates that take turns

Status: implemented

[English](2026-10-31-agent-team-take-turns.md) | 中文

## Problem

[Agent Teams](2026-08-05-agent-teams.zh.md) 并行运行 teammate，上限是 subagent 服务的 `maxActiveSubagents` 池。有些部署不能或不应同时运行多个 teammate：provider 套餐可能只允许一个并发请求，在同一个共享 checkout 中编辑的 teammate 也可能交错产生冲突的工作。把 `maxActiveSubagents` 设为 1 会让所有 continuable child 串行，而不只是 teammate；池满时还会直接拒绝 Activation，而不是排队等待。teammate 需要互相发送消息并等待回复，同时不在同一时间工作。轮流机制不能死锁：空闲的 teammate 和等待回复的 teammate 都不能占住轮次，已接收的消息要保持持久 inbox 中的顺序，Lead 也要能继续工作。

## Decision

`@deepseek-ai/dsh-experimental-agent-team` 接受 `takeTurns`，默认值为 `false`。为 `true` 时，Team 服务在 `TurnQueue`（`src/turns.ts`）中为每个 Team 保存一个进程内轮次：当前授予，以及一个先进先出的等待 teammate 列表。只有 roster 中的 teammate 参与轮流；Lead 和 roster 之外的 Agent 从不等待轮次。

`TeamTurnGate` 在三个位置执行轮次：

- **Inbox 插入。** 空闲 teammate 收到 `agent/inbox/inserted` 时，它会占用空闲的轮次，或启动一个等待轮次的 Agent maintenance hold。投递此前已把输入记录到持久 inbox 中，Agent loop 会锁存该输入的唤醒，直到 hold 结束。forge worktree hold 使用同一机制。
- **步骤准入。** 前置的 `agent/pre-step` 监听器让没有轮次的 teammate 步骤先等待，再进行其他步骤工作。它覆盖绕过 hold 的唤醒：宿主以 keep-inbox 方式中断并取消 hold，以及其他 maintenance 占用该 teammate 时到达的输入。
- **等待 Team 活动。** `waitForChange()` 先注册等待者，再把调用方的轮次交给下一个等待中的 teammate，并在返回前重新等待轮次。

轮次在以下时刻移交：持有者的 `agent/status` 空闲边、持有者离开注册表、`waitForChange()` 让出轮次，以及某个授予对应的 Agent 未使用该授予就再次空闲。roster 将排队中的 teammate 报告为 `waiting`，将持有者报告为 `running`。中断等待中的 teammate 不会取消任何工作，并报告 `previousStatus: 'waiting'`。只有 Team 轮流工作时，`@deepseek-ai/dsh-experimental-tool-agent-team` 才会在策略中加入轮流段落，并在 `list_agents` 和 `wait_agent` 的描述中加入 `waiting`，因此并行 Team 的提示保持不变。

## Deadlock freedom

任何 Team 操作都不会在持有轮次时等待轮次。发送在 inbox 接收时返回。创建在初始提示已在持久 inbox 中待处理时返回，而 hold 不会移动该提示。`waitForChange()` 在等待前释放轮次，Lead 从不等待轮次。因此持有者一定会进入空闲或进入会释放轮次的等待；授予按先进先出顺序移交，所以每个等待中的 teammate 最终都会工作。因其他原因阻塞的持有者（例如长时间命令或等待人类回应的提示）会推迟轮流，但不会造成死锁；Lead 可以中断该持有者。

## Alternatives considered

### 为什么不使用 `maxActiveSubagents: 1`？

它会限制 root 下的每个 continuable child，包括普通 subagent 和 workflow child。池满时还会以 `ACTIVATION_LIMIT_REACHED` 拒绝 Activation，因此发给已存储 teammate 的消息会失败，而不是等待轮次。

### 为什么不只在 `agent/pre-step` 中拦截？

步骤在 `agent/pre-step` 运行前就已从持久 inbox claim 输入，并且之后才把它记录为 `user/message`。在这里等待轮次会让输入两处都不在，因此等待期间的取消或崩溃会丢失输入。`spawnTeammate()` 也会一直阻塞到新 teammate 轮到为止，因为 provisioning 要等初始提示处于待处理或已记录状态。因此 pre-step 监听器只作为绕过 hold 的唤醒的兜底。

### 为什么不在轮到之前把消息留在 Team 中？

`sendMessage()` 会在 inbox 接收之前返回，因此无法再报告目标 inbox 的 `MessageId`；重启也会丢失 Team 没有持久化的消息。

### 为什么不让 Lead 参与轮流？

Lead 运行的是人类的会话；占住 Lead 会让用户提示排在 teammate 工作之后。在 Lead 轮次后汇合 child 的宿主代码（例如 headless runner）也需要自己的释放规则。让 Lead 不参与轮流，可以使所有 Lead 路径都不等待轮次。

### 为什么不使用 `maxActiveTeammates` 这样的数量？

所需行为是一个正在工作的 teammate，没有消费者需要介于一和 subagent 池之间的上限。轮流、`waiting` 状态和面向模型的文本都针对一个正在工作的 teammate 编写。

## Testing

`packages/experimental/agent-team/tests/take-turns.spec.ts` 通过一个请求由测试控制返回的模型驱动真实 Agent。它固定了以下行为：Lead 工作时同一时间只有一个 teammate 工作；轮次交给消息接收方并随回复交回；三个 teammate 互相发送消息时不会死锁，且每个 inbox 保持顺序；`waitForChange()` 的移交；先进先出顺序；中断等待中的 teammate；从未使用的授予；pre-step 兜底；roster 之外的 Agent；以及卸载与重新加载。同一文件还对 `TurnQueue` 做了单元测试。`packages/experimental/tool-agent-team/tests/tool-team.spec.ts` 逐字固定每种策略变体和轮流工具文本，并通过真实工具调用驱动 `wait_agent` 移交。`snapshots/session/team-take-turns` 场景通过 `dsh --profile headless` 回放该组合：writer 持有轮次，reviewer 等待，writer 的 `wait_agent` 移交轮次并收到回复。

## Consequences

该选项让 teammate 依次工作，同时不改变消息接收、持久性或默认的并行行为。代价是以下限制，包 README 中也有记录：

- 轮次顺序只在进程内。重启后，等待中的 teammate 已接收的消息会保持待处理，直到该 teammate 收到另一条消息。
- teammate 在长时间命令、缓慢的模型请求以及等待人类回应的提示期间都保持轮次。
- 在 pre-step 兜底处等待的步骤已经 claim 了输入，取消或进程退出会丢失这些输入。
- Web 面板根据 Session 状态推导活动，因此把等待中的 teammate 显示为 inactive。
- teammate 自己的 subagent 不参与轮流。
