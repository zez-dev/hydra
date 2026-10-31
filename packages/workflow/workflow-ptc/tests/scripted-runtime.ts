// Stands in for the sandboxed PTC executor so workflow specs can drive the
// host bindings directly. The executor is an external process this host cannot
// always start; everything above it stays real.
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'

type HostBindings = Record<string, PtcBindingFunction>

/** One `agent()` call as the guest would issue it. */
export interface ScriptedCall {
  readonly prompt: string
  readonly provider?: string
  readonly model?: string
  /** Label the guest reports for the started child, as `agent({ label })` does. */
  readonly label?: string
  /** Phase the guest reports for the started child. */
  readonly phase?: string
}

/**
 * A runtime whose "script" is a fixed list of calls: it drives the host
 * bindings the way the guest does, one `startChild` then `childResult` per
 * call, and returns the guest's terminal result.
 */
export class ScriptedRuntime extends PtcRuntime {
  language = 'typescript'
  readonly isolation = 'process'
  calls: ScriptedCall[] = []
  /** Issue every `startChild` before any `childResult`, as `parallel()` does. */
  concurrent = false

  /** Read-only confinement, as the sandboxed executor reports; the engine refuses an unconfined runtime under a read-only policy. */
  override get sandboxMode(): 'read-only' { return 'read-only' }

  /**
   * @param request - the engine's run request.
   * @returns the request with the fields a spec requires.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    return {
      ...request,
      cwd: request.cwd ?? process.cwd(),
      timeoutMs: request.timeoutMs === undefined ? 120_000 : request.timeoutMs,
    }
  }

  /**
   * @param spec - the resolved run spec carrying the host bindings.
   * @returns the guest result: the child ids, in call order.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const host = spec.bindings[0]!.functions as HostBindings
    const started = await Promise.all(this.calls.map(async ({ label, phase, ...call }) => {
      const handle = await host.startChild!(call) as { callId: number; childId: string }
      if (label !== undefined) {
        const info = { seq: handle.callId, label, childId: handle.childId, ...phase === undefined ? {} : { phase } }
        await host.progress!([{ type: 'agent-start', info }])
      }
      if (!this.concurrent) await host.childResult!({ callId: handle.callId })
      return handle
    }))
    if (this.concurrent) await Promise.all(started.map(handle => host.childResult!({ callId: handle.callId })))
    return {
      logs: [],
      value: { value: started.map(handle => handle.childId), stopReason: 'completed', agentsStarted: started.length },
    }
  }
}

/** What a scripted provider reports about the children it was asked to start. */
export interface ProviderLog {
  /** Prompts the provider actually started a child for, in order. */
  readonly starts: string[]
  /** Stop reason to answer a given prompt with; absent means `completed`. */
  readonly answers: Map<string, string>
}

/**
 * Build a subagent provider that records its starts and answers from a script.
 * @param log - the starts array and per-prompt stop reasons to honour.
 * @returns the provider, ready for `ctx.subagents.registerProvider`.
 */
export function scriptedProvider(log: ProviderLog) {
  let issued = 0
  return {
    name: 'stub',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: async (request: { prompt: { text?: string }[] }) => {
      const prompt = request.prompt[0]?.text ?? ''
      log.starts.push(prompt)
      const stopReason = log.answers.get(prompt) ?? 'completed'
      return {
        id: SessionId(`child-${String(++issued)}`),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text' as const, text: `answer to ${prompt}` }], stopReason }),
        dispose: () => Promise.resolve(),
      }
    },
  }
}
