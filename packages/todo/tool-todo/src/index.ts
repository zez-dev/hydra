/**
 * Model-facing whole-list replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning list and is rejected. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The open-todo reminder this tool steers. The kind is the name released
     * Hydra logs migrate this producer's sources to.
     * @persistenceAttribution
     */
    'plugin:tool-todo': { kind: 'plugin:tool-todo' } & ContextFormed
  }
}
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/** Model-facing todo tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
  /**
   * Whether open tasks the model can no longer see (its latest `todo_write` left the visible
   * history, as after a checkpoint) or was cut off from (the previous turn ended in an error, a
   * cancel, or the output limit) come back as a task-state message on its next request (default true).
   */
  remindOpenTodos?: boolean
  /**
   * How many times one turn that wrote the list may be asked to continue or update it when it
   * ends with open tasks (default 0, never). Off by default because a turn often stops with a
   * plan on purpose (the user asked only for the plan, or the reply hit its output limit), and
   * the push would spend a model call working against that.
   */
  maxOpenTodoContinuationsPerTurn?: number
}

/** Continuation requests per turn when `maxOpenTodoContinuationsPerTurn` is not configured. */
const DEFAULT_OPEN_TODO_CONTINUATIONS = 0

/** Schemastery configuration for the todo tool consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
  remindOpenTodos: z.boolean().default(true),
  maxOpenTodoContinuationsPerTurn: z.natural().default(DEFAULT_OPEN_TODO_CONTINUATIONS),
})

/** Source kind recorded on the task-state and continuation messages this package adds. */
const TODO_SOURCE_KIND = 'plugin:tool-todo'

/**
 * Whether a task still owes work.
 * @param item - one task.
 * @returns true for `pending` and `in_progress`.
 */
function isOpen(item: TodoItem): boolean {
  return item.status !== 'completed'
}

/**
 * Render the open tasks, one per line, in list order.
 * @param todos - the whole list.
 * @returns lines of the form `- [status] content`.
 */
function renderOpen(todos: readonly TodoItem[]): string {
  return todos.filter(isOpen).map(item => `- [${item.status}] ${item.content}`).join('\n')
}

/**
 * The task-state message for open tasks the model cannot see or was cut off from.
 * @param todos - the whole list.
 * @returns the model-facing text.
 */
function reminderText(todos: readonly TodoItem[]): string {
  return [
    '<task_list>',
    'Open tasks from your task list earlier in this session:',
    renderOpen(todos),
    'If they are still part of the work, continue with the in-progress one. If the current request moves on from them, update the list with `todo_write` (mark them completed or drop them) instead of continuing them.',
    '</task_list>',
  ].join('\n')
}

/**
 * The continuation request for a turn that planned work and stopped with tasks open.
 * @param todos - the whole list.
 * @returns the model-facing text.
 */
function continuationText(todos: readonly TodoItem[]): string {
  return [
    'Your task list still has open tasks:',
    renderOpen(todos),
    'Continue with the next one. If you are waiting on the user, or the plan changed, update the list with `todo_write` to match and then end your reply.',
  ].join('\n')
}

/**
 * Text of a message's text blocks.
 * @param message - any message.
 * @returns the joined text.
 */
function textOf(message: Message): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/**
 * Whether the model can currently see this exact list: its latest visible `todo_write` call
 * carries it, or a task-state message with the same open tasks is visible after that call.
 * @param session - the agent's session.
 * @param todos - the latest logged list.
 * @returns true when the list is on the model-visible history.
 */
function listVisible(session: Session, todos: readonly TodoItem[]): boolean {
  const reminder = reminderText(todos)
  const wanted = JSON.stringify(todos.map(item => ({ content: item.content, status: item.status })))
  for (const message of session.deriveMessages().toReversed()) {
    if (message.role === 'user' && textOf(message) === reminder) return true
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call' || block.name !== 'todo_write') continue
      try {
        const args = JSON.parse(block.arguments) as { todos?: { content: string; status: string }[] }
        const seen = (args.todos ?? []).map(item => ({ content: item.content.trim(), status: item.status }))
        return JSON.stringify(seen) === wanted
      } catch (_unparsable) {
        // A malformed call was rejected before it could write this list, so it does not show it.
        return false
      }
    }
  }
  return false
}

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial '
  + 'single-step tasks. Add one todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '

const DESCRIPTION_SINGLE =
  'While work remains, keep exactly one todo `in_progress`. '

const DESCRIPTION_TAIL = 'Mark each todo `completed` as soon as it is done.'

/**
 * The model-facing description for one activation. The active-status clause is the only part that
 * varies, because it is the only instruction the parallel policy changes.
 * @param allowParallel - whether several todos may be `in_progress` at once.
 * @returns the composed tool description.
 */
function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content, and at most one `in_progress` item unless the
 * deployment allows parallel work. The registry has already enforced the status enum and rejected
 * unknown item keys (`additionalProperties: false` — the logged snapshot must equal what the model
 * believes it wrote, so a nested/extended item shape fails loud at the schema boundary instead of
 * silently flattening); the cast below records that guarantee.
 * @param raw - the model-supplied list, already schema-checked.
 * @param allowParallel - whether several items may be `in_progress` at once.
 * @returns the canonical list.
 */
function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/**
 * Register the `todo_write` tool on `ctx.tools` and the `todos` unit on
 * `ctx.sessionProjections`.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 * @param config - deployment's explicit todo policy.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const allowParallel = config.allowParallelInProgress
  // Standing-plan fold: latest whole todo/write list, cleared by the next
  // turn/start (turn/end keeps the finished checklist visible); null before the
  // first write or after a later turn begins; every other event returns the
  // same state reference.
  const todosProjectionHandle = await ctx.sessionProjections.register<'todos', TodoItem[] | null>({
    key: 'todos',
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return event.data.todos
      if (event.type === 'turn/start') return state?.some(isOpen) === true ? state : null
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state, summary: false },
    stateVersion: 3,
  })
  installOpenTodoFollowUp(ctx, config, session => todosProjectionHandle.stateOf(session))
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}

/**
 * Keep open tasks from being dropped: a turn that wrote the list and stops with tasks open is
 * asked to continue or update it (at most `maxOpenTodoContinuationsPerTurn` times), and open
 * tasks come back as a task-state message when the model can no longer see its latest list or
 * the previous turn did not complete.
 * @param ctx - plugin context.
 * @param config - the reminder switch and the per-turn continuation cap.
 * @param latestList - reads the session's latest list; the `todos` projection keeps a list with
 *   open tasks across turns.
 */
function installOpenTodoFollowUp(
  ctx: Context,
  config: Config,
  latestList: (session: Session) => readonly TodoItem[] | null,
): void {
  // Schemastery (`Config`) fills the default before apply runs; the cast records that runtime fact.
  const maxContinuations = (config as Required<Pick<Config, 'maxOpenTodoContinuationsPerTurn'>>).maxOpenTodoContinuationsPerTurn
  /** The turn in which each session last wrote its list. */
  const writtenIn = new Map<SessionId, number>()
  /** Each session's current turn, and how many continuations it already asked for. */
  const turns = new Map<SessionId, { turn: number; continuations: number; previousCompleted: boolean }>()

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'todo/write': {
        const current = turns.get(session.id)
        if (current !== undefined) writtenIn.set(session.id, current.turn)
        break
      }
      case 'turn/start': {
        const previous = turns.get(session.id)
        turns.set(session.id, { turn: event.data.turn, continuations: 0, previousCompleted: previous?.previousCompleted ?? true })
        break
      }
      case 'turn/end': {
        const current = turns.get(session.id)
        if (current !== undefined) current.previousCompleted = event.data.reason.kind === 'completed'
        break
      }
      default:
        // Other events do not move the list or the turn.
        break
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    writtenIn.delete(agent.id)
    turns.delete(agent.id)
  })

  if (config.remindOpenTodos !== false) {
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const todos = latestList(agent.session)
      if (todos === null || !todos.some(isOpen)) return decision
      const cutOff = step === 1 && turns.get(agent.id)?.previousCompleted === false
      if (!cutOff && listVisible(agent.session, todos)) return decision
      const reminder: UserMessage = createUserMessage({
        content: [{ type: 'text', text: reminderText(todos) }],
        source: { kind: TODO_SOURCE_KIND, form: 'notice', summary: `Task list: ${todos.filter(isOpen).length} open tasks carried over` },
      })
      return { ...decision, messages: [...decision.messages, reminder] }
    })
  }

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted || maxContinuations === 0) return
    const current = turns.get(agent.id)
    if (current === undefined || current.turn !== turn || writtenIn.get(agent.id) !== turn) return
    const todos = latestList(agent.session)
    if (todos === null || !todos.some(isOpen) || current.continuations >= maxContinuations) return
    current.continuations += 1
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: continuationText(todos) }],
      source: { kind: TODO_SOURCE_KIND, form: 'notice', summary: `Task list: ${todos.filter(isOpen).length} open tasks remain` },
    }))
  })
}
