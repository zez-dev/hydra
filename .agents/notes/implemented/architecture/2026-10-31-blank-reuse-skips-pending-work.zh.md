# Agent Note: 复用空白 Session 时跳过待处理的工作

Status: implemented

[English](2026-10-31-blank-reuse-skips-pending-work.md) | 中文

## Problem

新会话会把空白 Session（尚未开始任何轮次的 Session）复用于下一段对话。空白 Session 仍可能持有其日志没有记录的工作：输入框的「稍后发送」控件会把一个 Schedule 任务绑定到输入框所在的 Session，该任务稍后把提示词投递进这个 Session。把这样的空白 Session 复用于一段无关的对话，就会把定时发送的提示词投递进那段对话。

## Decision

复用任意空白 Session 的调用方会请 Host 跳过被占的那些。新会话、重新打开工作区和准备草稿会带上 `skipActive`，按列表顺序指明第一个符合条件的空白 Session；`session.create` 随后只在工作区注册表的 `sessionActivity(sessionId)` 对它不报告任何内容时才复用它，否则新建另一个 Session，提供方抛错时创建失败。`sessionActivity` 询问的是归档准入已在询问的 `workspace/session-activity` waterfall（[归档准入](../feature/2026-09-21-archive-stops-running-session-work.zh.md)）。运行中的轮次、任务和 subagent 都需要已开始的轮次，因此对空白 Session 作答的是其工作比轮次活得更久的提供方：Schedule 插件的活动宿主任务。API Session Controller 不点名任何活动族，也不从 Schedule 插件导入任何内容。

不带 `skipActive` 的请求保留原有规则：无论指明的空白 Session 持有什么工作都会复用它，因此指明同一标识的重复请求都会返回它，这正是上游 `schedule-timing` expected 测试对绑定了预置任务数据的标识所要求的。启动恢复指明已保存的空白 Session 时不带 `skipActive`，因此重载会重新打开持有待处理工作的空白 Session；用户离开后，它与其他空白行一样保持隐藏，直到开始第一个轮次。

本决策扩展了[写锁获取记录](2026-09-17-process-local-blank-sessions.zh.md)中的空白 Session 复用策略。

## Alternatives considered

**在 Session Controller 中检查 Schedule。** 这会把一个业务族放进 `packages/api`。活动 waterfall 已让每个提供方为自己的工作作答，后续的提供方无需改动控制器即可加入。

**对每个指明 Session 的请求都跳过被占的空白 Session。** 它不需要请求字段，但会破坏显式标识采用的幂等性：第二次指明绑定了预置任务数据的标识的 `session.create` 会返回一个新 Session，重载也会替换掉用户最后看到的 Session。

**在 Session 列表摘要中加入待处理工作的事实。** 导航本可以自行跳过被占的空白 Session，但 Schedule 任务不是会话事件，因此任何会话投影都无法携带这一事实。该事实需要在提供方的工作每次变化时各自失效，而 Host 仍须执行这条规则。

**由 Host 在候选空白 Session 中挑选。** 发送所有符合条件的空白 Session、复用第一个空闲的，可以避免被拒后多出的 Session，但这会改变 `session.create` 请求，而启动恢复指明唯一的标识，正是为了让 Host 能以该标识重建未存储的空白 Session。

## Consequences

新会话绝不会把持有活动任务的空白 Session 交给另一段对话，因此「稍后发送」可以在新对话中使用，重载也会带着草稿回到该 Session。当第一个候选持有工作时，新会话会再创建一个空白 Session，而不继续寻找；新建的 Session 位于客户端列表最前，因此下一次新会话会回到它。不带 `skipActive` 指明某个标识的调用方，即使该标识持有工作也会拿到它。放置规则的回答与复用并非原子的一步：在回答之后、复用之前绑定到指明 Session 的任务，会投递进复用它的那段对话。

## Verification

Session Controller 测试在 `skipActive` 下拒绝复用注册表报告有工作的活动空白 Session 与已存储空白 Session，在不带它时复用被占的空白 Session，并在活动询问抛错时使创建失败。导航测试固定了工作区连接带 `skipActive` 指明其空白 Session，而启动恢复不带它指明已保存的空白 Session。Workspace 注册表测试固定了 waterfall 的回答顺序、没有提供方时的空回答，以及它不写入任何内容。上游 `schedule-timing` expected 测试两次采用绑定了预置任务数据的标识。一个随附 Web 组合测试把任务绑定到选中的空白 Session，并检查新会话会打开另一个 Session、重载会带着草稿与任务重新打开被占的空白 Session。
