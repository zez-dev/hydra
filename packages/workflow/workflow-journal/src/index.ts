/**
 * Service Provider for the durable workflow-run journal. A workflow engine
 * records each run and every settled `agent()` call here, so a later run
 * started with `resumeRunId` replays the completed calls whose position and
 * input hash still match instead of spawning children that already answered.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-workflow-journal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  JournalCall,
  ResumePlan,
  WorkflowJournalService,
  WorkflowRunOpen,
  WorkflowRunRecord,
  WorkflowResult,
} from '@deepseek-ai/dsh-workflow'

export const name = 'workflow-journal'
export const inject = ['storageDomain', 'commands']

/** Plugin configuration (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Runs retained before the oldest settled ones are pruned (default 200). */
  retainRuns?: number
  /** Rows `/workflows` prints when the caller names no run (default 20). */
  listLimit?: number
}

const DEFAULT_RETAIN_RUNS = 200
const DEFAULT_LIST_LIMIT = 20

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  retainRuns: z.natural().min(1).default(DEFAULT_RETAIN_RUNS),
  listLimit: z.natural().min(1).default(DEFAULT_LIST_LIMIT),
})

const callRow = zod.object({
  ordinal: zod.number().int().positive(),
  kind: zod.literal('agent'),
  keyHash: zod.string(),
  childId: zod.string(),
  label: zod.string().optional(),
  phase: zod.string().optional(),
  settledAt: zod.string(),
  outcome: zod.object({
    ok: zod.boolean(),
    value: zod.unknown().optional(),
    error: zod.string().optional(),
  }),
})

const runRow = zod.object({
  id: zod.string(),
  sessionId: zod.string(),
  scriptHash: zod.string(),
  meta: zod.looseObject({ name: zod.string(), description: zod.string() }),
  startedAt: zod.string(),
  state: zod.union([
    zod.literal('running'),
    zod.literal('done'),
    zod.literal('failed'),
    zod.literal('interrupted'),
  ]),
  finishedAt: zod.string().optional(),
  result: zod.unknown().optional(),
  resumedFrom: zod.string().optional(),
  calls: zod.array(callRow),
})

type RunRow = zod.infer<typeof runRow>

/** The `workflow_runs` domain: one record per run, carrying its settled calls. */
export const workflowRunsDomainSpec = defineDomain({
  name: 'workflow_runs',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    runs: domainTable<string, RunRow>(runRow),
  },
})

/**
 * Project a stored row onto the service's record type.
 * @param row - the stored row.
 * @returns the record.
 */
function toRecord(row: RunRow): WorkflowRunRecord {
  return {
    id: WorkflowRunId(row.id),
    sessionId: brandString<SessionId>(row.sessionId),
    scriptHash: row.scriptHash,
    meta: row.meta,
    startedAt: row.startedAt,
    state: row.state,
    ...row.finishedAt === undefined ? {} : { finishedAt: row.finishedAt },
    ...row.result === undefined ? {} : { result: row.result as WorkflowResult },
    ...row.resumedFrom === undefined ? {} : { resumedFrom: WorkflowRunId(row.resumedFrom) },
    calls: row.calls as readonly JournalCall[],
  }
}

/**
 * Render one `/workflows` row.
 * @param record - the run to render.
 * @returns a single display line.
 */
function renderRun(record: WorkflowRunRecord): string {
  const phases = new Set(record.calls.map(call => call.phase).filter((phase): phase is string => phase !== undefined))
  const failed = record.calls.filter(call => !call.outcome.ok).length
  const parts = [
    `${record.id.slice(0, 8)}  ${record.state.padEnd(11)} ${record.meta.name}`,
    `${String(record.calls.length)} settled call(s)`,
    ...failed > 0 ? [`${String(failed)} not replayable`] : [],
    ...phases.size > 0 ? [`${String(phases.size)} phase(s)`] : [],
    record.startedAt,
  ]
  return parts.join('  ·  ')
}

/**
 * Mount the journal service and `/workflows`.
 * @param ctx - registrant context carrying `storageDomain` and `commands`.
 * @param config - deployment configuration.
 * @returns once the domain is open and runs left behind by a dead process are reconciled.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain: Domain<typeof workflowRunsDomainSpec> = await ctx.storageDomain.open(workflowRunsDomainSpec)
  const table: KvTable<string, RunRow> = domain.table('runs')

  // A run still marked `running` belongs to a process that is gone: this
  // activation is the first moment anything could have read it back.
  for (const [key, row] of table.entries()) {
    if (row.state !== 'running') continue
    await table.put(key, { ...row, state: 'interrupted', finishedAt: new Date().toISOString() })
  }

  // One write chain per run id. A read-modify-write on the run's calls is not
  // atomic, and an engine starts `record()` for concurrent `agent()` calls
  // without awaiting the previous one, so unordered writes would lose calls.
  const tails = new Map<string, Promise<void>>()

  function enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const previous = tails.get(id) ?? Promise.resolve()
    // Both arms run `work`: one failed write must not strand the run's chain.
    const next = previous.then(work, work)
    tails.set(id, next)
    void next.catch(() => {}).then(() => {
      if (tails.get(id) === next) tails.delete(id)
    })
    return next
  }

  // The journal owns its domain handle: unloading lets every queued run write
  // land, then closes the domain, so a remount can open it again.
  ctx.effect(() => async () => {
    await Promise.allSettled([...tails.values()])
    await domain.close()
  }, 'workflowJournal.domainClose')

  // Schemastery (`Config`) fills both defaults before apply runs; the cast records that runtime fact.
  const { retainRuns, listLimit } = config as Required<Config>

  async function prune(): Promise<void> {
    if (table.size <= retainRuns) return
    const settled = [...table.entries()]
      .filter(([, row]) => row.state !== 'running')
      .sort(([, left], [, right]) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    const excess = table.size - retainRuns
    for (const [key] of settled.slice(0, excess)) await table.delete(key)
  }

  const service: WorkflowJournalService = {
    open(open: WorkflowRunOpen): Promise<void> {
      return enqueue(open.id, async () => {
        await table.put(open.id, {
          id: open.id,
          sessionId: open.sessionId,
          scriptHash: open.scriptHash,
          meta: open.meta as RunRow['meta'],
          startedAt: new Date().toISOString(),
          state: 'running',
          ...open.resumedFrom === undefined ? {} : { resumedFrom: open.resumedFrom },
          calls: [],
        })
        await prune()
      })
    },

    record(id, call): Promise<void> {
      return enqueue(id, async () => {
        const row = table.get(id)
        // A call can only settle inside a run the engine opened; a missing row
        // means the journal was mounted after the run began, and dropping the
        // call keeps the record honest rather than inventing a run.
        if (row === undefined) return
        await table.put(id, { ...row, calls: [...row.calls, call] })
      })
    },

    close(id, result): Promise<void> {
      return enqueue(id, async () => {
        const row = table.get(id)
        if (row === undefined) return
        await table.put(id, {
          ...row,
          state: result.stopReason === 'completed' ? 'done' : 'failed',
          finishedAt: new Date().toISOString(),
          result,
        })
      })
    },

    get(id) {
      const row = table.get(id)
      return row === undefined ? undefined : toRecord(row)
    },

    list(limit = listLimit) {
      return [...table.entries()]
        .map(([, row]) => toRecord(row))
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .slice(0, limit)
    },

    plan(id, hash): ResumePlan | undefined {
      const row = table.get(id)
      if (row === undefined) return undefined
      return {
        runId: WorkflowRunId(row.id),
        replayable: row.calls.filter(call => call.outcome.ok).length,
        scriptChanged: row.scriptHash !== hash,
        state: row.state,
      }
    },
  }

  ctx.provide('workflowJournal', service)

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-workflow-journal'),
    name: 'workflows',
    description: 'List recent workflow runs and what resuming one would replay',
    input: { hint: '[<run-id>]' },
    handler: (invocation) => {
      const argument = invocation.rawInput.trim()
      if (argument.length > 0) {
        const record = service.get(WorkflowRunId(argument))
        if (record === undefined) return { kind: 'error', text: `no journaled workflow run "${argument}"` }
        const lines = [
          renderRun(record),
          `script ${record.scriptHash}`,
          ...record.resumedFrom === undefined ? [] : [`resumed from ${record.resumedFrom}`],
          ...record.calls.map(call =>
            `  #${String(call.ordinal)} ${call.outcome.ok ? 'replayable' : 'runs again'} ${call.keyHash}  ${call.label ?? '(unlabelled)'}`),
          '',
          'Resuming replays the completed calls whose prompt and route are unchanged; everything else runs again.',
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      const records = service.list()
      if (records.length === 0) return { kind: 'success', text: 'no workflow runs journaled yet' }
      return { kind: 'success', text: records.map(renderRun).join('\n') }
    },
  }), 'workflow-journal: /workflows')
}
