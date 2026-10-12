import type { Agent } from '@deepseek-ai/dsh-agent'

/** Verdict of one check. */
export type DoctorStatus = 'ok' | 'warn' | 'fail'

/** One line of the report. */
export interface DoctorRow {
  /** Report section: `home`, `workspace`, `sandbox`, `native`, `git`, `plugins`, `tools`, `credentials`. */
  readonly section: string
  /** Short check name, unique within its section. */
  readonly check: string
  readonly status: DoctorStatus
  /** What was observed, never a secret. */
  readonly detail: string
  /** One-line remedy for a `warn` or `fail` row. */
  readonly fix?: string
}

/** Counts by status. */
export interface DoctorSummary {
  readonly ok: number
  readonly warn: number
  readonly fail: number
}

/** The assembled report. */
export interface DoctorReport {
  /** ISO timestamp of the run. */
  readonly generatedAt: string
  readonly rows: readonly DoctorRow[]
  readonly summary: DoctorSummary
}

/** A provider route to probe with one tiny request. */
export interface DoctorRoute {
  readonly provider: string
  readonly model: string
}

/** Options of one run. */
export interface DoctorOptions {
  /** Workspace to inspect; defaults to the invoking agent's session cwd, else `process.cwd()`. */
  readonly cwd?: string
  /** Send one tiny model request per route and report latency or the failure class. */
  readonly probe?: boolean
  /** Route to probe; defaults to the deployment default selection when `agentDefaultModel` is mounted. */
  readonly route?: DoctorRoute
  /** Create the `.dsh/` workspace folders (`research` and `reports`) when missing. The only mutation the doctor ever performs. */
  readonly fix?: boolean
  /** Invoking agent, whose session provides the cwd and route defaults. */
  readonly agent?: Agent
}

/** Result of one synchronous child process. */
export interface SpawnResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * The host facts the checks read. Production binds Node and the native
 * addon; tests inject fakes so every verdict is reproducible.
 */
export interface DoctorEnvironment {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether a path exists. */
  exists(path: string): boolean
  /** Whether the current user may write to an existing path. */
  writable(path: string): boolean
  /** Read a small text file, or `undefined` when it cannot be read. */
  readText(path: string): string | undefined
  /** Run a child process synchronously with a timeout; a missing executable yields a null status. */
  spawn(command: string, args: readonly string[], options: { cwd?: string; timeoutMs: number }): SpawnResult
  /** Absolute path of the Landlock runner this host would exec. */
  launcherPath(): string
  /** The Landlock runner's probe verdict. */
  probeLandlock(): 'full' | 'partial' | 'unusable'
  /** Absolute path where the host Node-API addon must exist. */
  addonBinary(): string
}

/** Failure class of a probe request. */
export type ProbeErrorClass = 'auth' | 'context' | 'quota' | 'network' | 'error'

/** Test seam over the host facts, set on the service after activation. */
export interface DoctorInternals {
  environment?: DoctorEnvironment
}

/** The `ctx.doctor` service. */
export interface DoctorService {
  /**
   * Run every check.
   * @param options - workspace, probe, fix, and route selection.
   * @returns the assembled report.
   */
  run(options?: DoctorOptions): Promise<DoctorReport>
  /**
   * Render a report as the plain-text table `/doctor` prints.
   * @param report - a report from {@link DoctorService.run}.
   * @returns the table text.
   */
  render(report: DoctorReport): string
  /** Host-fact overrides used by tests. */
  internals: DoctorInternals
}
