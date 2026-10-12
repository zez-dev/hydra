/**
 * Background knowledge runs as `knowledge-enrich` jobs: `/kb enrich`, `/kb
 * embed`, and the summaries `knowledge_add` starts once the user approves them.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'knowledge-enrich': 'knowledge-enrich'
  }
}

/**
 * Start one knowledge run as a `knowledge-enrich` job owned by an agent.
 * The job completes with `complete`'s detail and output, ends `killed` when it
 * was cancelled, and ends `failed` with the error message otherwise.
 * @param jobs - the job registry.
 * @param owner - the agent that owns the job; its disposal cancels the run.
 * @param label - the job label.
 * @param cancelled - the cancellation message when the job is killed without a reason.
 * @param work - the work, given the job's cancellation signal.
 * @param complete - the completed job's detail and output from the work's result.
 * @returns the job id.
 */
export function startKnowledgeJob<T>(
  jobs: Context['jobs'],
  owner: NonNullable<JobStart['owner']>,
  label: string,
  cancelled: string,
  work: (signal: AbortSignal) => Promise<T>,
  complete: (result: T) => { detail: string; output: string },
): JobId {
  const controller = new AbortController()
  return jobs.start({
    kind: 'knowledge-enrich',
    label,
    owner,
    run: () => ({
      cancel: (reason) => { controller.abort(new Error(reason ?? cancelled)) },
      done: work(controller.signal).then(
        result => ({ status: 'completed' as const, ...complete(result) }),
        (error: unknown) => ({
          status: controller.signal.aborted ? 'killed' as const : 'failed' as const,
          detail: error instanceof Error ? error.message : String(error),
        }),
      ),
    }),
  })
}
