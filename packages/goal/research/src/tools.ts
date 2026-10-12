/** Agent-facing research journal and experiments over the same service `/research` drives. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { extractMetrics, metricDeltas, previousExperiment, renderExperimentResult, truncateOutput } from './experiment.ts'
import type { MetricSpec } from './experiment.ts'
import { renderJournalFile } from './journal.ts'
import type { Journal } from './types.ts'

/** Required services for the research tools. */
export const inject = ['tools', 'research']

const HYPOTHESIS_STATUSES = ['open', 'supported', 'refuted'] as const

/**
 * Project a journal onto the plain JSON the `read` action returns.
 * @param journal - the journal.
 * @returns every recorded field, arrays copied.
 */
function journalJson(journal: Journal): JsonValue {
  return {
    slug: journal.slug,
    objective: journal.objective,
    criteria: [...journal.criteria],
    status: journal.status,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    sessions: [...journal.sessions],
    breakthroughs: journal.breakthroughs.map(entry => ({ ...entry })),
    hypotheses: journal.hypotheses.map(entry => ({ ...entry })),
    experiments: journal.experiments.map(entry => ({ ...entry })),
    deadEnds: journal.deadEnds.map(entry => ({ ...entry })),
    nextSteps: [...journal.nextSteps],
  }
}

/**
 * Register the `run_experiment` and `journal` tools.
 * @param ctx Agent-scoped tool registration context; `shell` and `shellEnv` are read when mounted.
 */
export function apply(ctx: Context): void {
  // The `run_experiment` tool: a budgeted command run whose exit code, metrics,
  // deltas, and output excerpt land in the journal as one experiment entry.
  ctx.tools.register(defineTool({
    name: 'run_experiment',
    description: 'Run one research experiment as a shell command in the workspace and record it in the research journal: '
      + 'the command, exit code, metrics read from the output with your regular expressions, deltas against the previous run '
      + 'with the same `title`, and an output excerpt. Use it instead of `bash` for experiments so results are never lost. '
      + 'Requires an active research goal in this session (start one with /research).',
    parameters: {
      title: { type: 'string', required: true, description: 'Short stable name of the experiment; repeating a title yields per-metric deltas.' },
      command: { type: 'string', required: true, description: 'The shell command to run in the workspace directory.' },
      hypothesisId: { type: 'string', description: 'The journal hypothesis this experiment tests.' },
      timeoutMs: { type: 'number', description: 'Time budget in milliseconds; capped by the deployment maximum.' },
      metrics: {
        type: 'array',
        description: 'Metrics to read from stdout and stderr; the first capture group (else the whole match) must be a number.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Metric name.' },
            regex: { type: 'string', required: true, description: 'JavaScript regular expression.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const outcome = value as { id: string; summary: string }
        return [{ type: 'text', text: `Recorded ${outcome.id}: ${outcome.summary}` }]
      },
    },
    async execute(args, exec): Promise<JsonValue> {
      const agent = exec.agent
      const cwd = agent?.session.header.cwd
      if (agent === undefined || cwd === undefined) throw new Error('run_experiment requires a session with a workspace directory')
      const research = ctx.research
      const active = research.activeFor(agent.id)
      if (active === undefined) throw new Error('run_experiment requires an active research goal in this session (start one with /research)')
      const shell = ctx.get('shell')
      if (shell === undefined) throw new Error('run_experiment requires a shell executor (mount a bash executor such as dsh-bash-local)')
      const store = research.storeFor(active.cwd)
      await store.whenReady()
      const journal = store.get(active.slug)
      if (journal === undefined) throw new Error(`no research journal "${active.slug}" under ${store.dir}`)
      if (args.hypothesisId !== undefined && !journal.hypotheses.some(entry => entry.id === args.hypothesisId)) {
        throw new Error(`no hypothesis ${args.hypothesisId} in "${active.slug}"`)
      }
      const title = args.title.trim()
      if (title.length === 0) throw new Error('run_experiment requires a non-empty `title`')
      const limits = research.experimentLimits
      const timeoutMs = Math.min(args.timeoutMs ?? limits.maxExperimentMs, limits.maxExperimentMs)
      const specs: MetricSpec[] = (args.metrics ?? []).map(spec => ({ name: spec.name, regex: spec.regex }))
      const dshEnv = ctx.get('shellEnv')?.collect(exec)
      const result = await shell.run(shell.resolve({
        command: args.command,
        workdir: cwd,
        timeoutMs,
        ...dshEnv === undefined ? {} : { dshEnv },
        signal: exec.signal,
      }))
      if (result.aborted) throw new Error('run_experiment aborted')
      const raw = [result.stdout.text, result.stderr.text].filter(text => text.length > 0).join('\n')
      const metrics = extractMetrics(raw, specs)
      const deltas = metricDeltas(previousExperiment(journal, title)?.metrics, metrics)
      const { text: output, truncated } = truncateOutput(raw, limits.maxOutputBytes)
      const outcome = { exitCode: result.exitCode, timedOut: result.timedOut, metrics, deltas, output: truncated ? `${output} […]` : output }
      const summary = renderExperimentResult(outcome)
      const entry = await store.addExperiment(active.slug, `${title}: ${args.command}`, summary, 'model', {
        title,
        metrics,
        ...args.hypothesisId === undefined ? {} : { hypothesisId: args.hypothesisId },
      })
      await research.scoreHypotheses(store, active.slug, agent.session, exec.signal)
      return { id: entry.id, exitCode: result.exitCode, timedOut: result.timedOut, metrics, deltas, output: outcome.output, summary }
    },
  }))

  // The `journal` tool: model-owned, immediate entries against the session's research.
  ctx.tools.register(defineTool({
    name: 'journal',
    description: 'The research journal of this workspace: the durable memory of a research goal across sessions. '
      + '`breakthrough` records a confirmed step toward the objective; `hypothesis` adds one (text) or sets its status (id + status); '
      + '`experiment` records what was tried and the result; `dead_end` records what must not be retried and why; '
      + '`next` replaces the next steps; `read` returns the journal. Entries are written to the journal file at once and recalled '
      + 'into every later request, so record findings the moment they happen. `slug` defaults to the research this session runs.',
    parameters: {
      action: { type: 'string', required: true, enum: ['breakthrough', 'hypothesis', 'experiment', 'dead_end', 'next', 'read'], description: 'The operation.' },
      slug: { type: 'string', description: 'Journal slug; defaults to the active research of this session.' },
      text: { type: 'string', description: 'breakthrough/hypothesis/dead_end: one or two sentences.' },
      id: { type: 'string', description: 'hypothesis: the hypothesis id to update.' },
      status: { type: 'string', enum: [...HYPOTHESIS_STATUSES], description: 'hypothesis: the new status when `id` is given.' },
      what: { type: 'string', description: 'experiment: what was tried.' },
      result: { type: 'string', description: 'experiment: what happened.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'next: the next steps in order.' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        switch (args.action) {
          case 'read':
            return [{ type: 'text', text: renderJournalFile(value as unknown as Journal) }]
          case 'next':
            return [{ type: 'text', text: 'Next steps replaced.' }]
          default:
            return [{ type: 'text', text: `Recorded ${(value as { id: string }).id}.` }]
        }
      },
    },
    async execute(args, exec): Promise<JsonValue> {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('journal requires a session with a workspace directory')
      const research = ctx.research
      const store = research.storeFor(cwd)
      await store.whenReady()
      const active = exec.agent === undefined ? undefined : research.activeFor(exec.agent.id)
      const slug = args.slug ?? active?.slug
      if (slug === undefined) throw new Error('journal requires `slug` when the session has no research goal (start one with /research)')
      const journal = store.get(slug)
      if (journal === undefined) {
        const existing = store.list().map(entry => entry.slug).join(', ') || 'none'
        throw new Error(`no research journal "${slug}" (existing: ${existing})`)
      }
      const requireText = (): string => {
        if (args.text === undefined || args.text.trim().length === 0) throw new Error(`${args.action} requires \`text\``)
        return args.text
      }
      switch (args.action) {
        case 'breakthrough': {
          const text = requireText()
          const entry = await store.addBreakthrough(slug, text, 'model')
          research.announceBreakthrough(journal, text)
          return { id: entry.id }
        }
        case 'hypothesis': {
          if (args.id !== undefined) {
            if (args.status === undefined) throw new Error('hypothesis with `id` requires `status`')
            const entry = await store.setHypothesis(slug, args.id, args.status)
            return { id: entry.id, status: entry.status }
          }
          const entry = await store.addHypothesis(slug, requireText(), 'model')
          return { id: entry.id, status: entry.status }
        }
        case 'experiment': {
          if (args.what === undefined || args.result === undefined) throw new Error('experiment requires `what` and `result`')
          const entry = await store.addExperiment(slug, args.what, args.result, 'model')
          if (exec.agent !== undefined) await research.scoreHypotheses(store, slug, exec.agent.session, exec.signal)
          return { id: entry.id }
        }
        case 'dead_end': {
          const entry = await store.addDeadEnd(slug, requireText(), 'model')
          return { id: entry.id }
        }
        case 'next': {
          if (args.steps === undefined) throw new Error('next requires `steps`')
          const updated = await store.setNextSteps(slug, args.steps)
          return { nextSteps: [...updated.nextSteps] }
        }
        case 'read':
          return journalJson(store.get(slug) ?? journal)
        default:
          throw new Error(`unknown action ${String(args.action)}`)
      }
    },
  }))
}
