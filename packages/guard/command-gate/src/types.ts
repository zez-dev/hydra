/**
 * Command-gate vocabulary: the parsed shell shapes the classifier reads, its
 * verdicts, and the durable record of a blocked attempt.
 * @module
 */

/** One redirection a simple command carries. */
export interface Redirection {
  /** `>` truncates, `>>` appends; `<` reads. */
  readonly operator: '>' | '>>' | '<'
  /** Literal target as written, before workspace resolution. */
  readonly target: string
}

/**
 * One simple command: an argv plus its redirections. A pipeline, a `&&` chain,
 * a subshell, and a `sh -c` payload all flatten into several of these, so a
 * rule never has to know which syntax hid the command.
 */
export interface SimpleCommand {
  /**
   * Words after quote removal, leading `NAME=value` assignments left out;
   * `argv[0]` is the program. A redirection written without a command word,
   * which the shell runs as its null command, carries the empty program `''`.
   */
  readonly argv: readonly [string, ...string[]]
  /** Redirections attached to this command. */
  readonly redirections: readonly Redirection[]
  /**
   * Program of the command this one pipes INTO, when it does. `curl … | sh` is
   * only dangerous because of this edge, which a per-command rule cannot see.
   */
  readonly pipesInto?: string
  /**
   * The working directories the command may run in, when a `cd` earlier in the
   * line moved it. Each entry is one directory, written as the `cd` targets
   * that lead to it from where the line starts, applied in order. Several
   * entries mean the line leaves open which `cd` took effect, as after
   * `cd dir;`, so a rule judges each one. Absent when the command runs where
   * the line starts.
   */
  readonly directories?: readonly (readonly string[])[]
  /**
   * Set when the program also receives arguments read from standard input at
   * run time, as `xargs` passes them, so `argv` does not list every operand.
   */
  readonly argumentsFromInput?: true
}

/** What the gate does with one command. */
export type CommandVerdict = 'allow' | 'confirm' | 'deny'

/** One classification: the verdict, the rule that produced it, and why. */
export interface Classification {
  readonly verdict: CommandVerdict
  /** Stable rule id; `allow` carries `none`. Configuration names these. */
  readonly rule: string
  /** Model-facing sentence naming what was blocked and the way forward. */
  readonly reason: string
}

/** Everything a rule needs about where the command would run. */
export interface CommandContext {
  /** Absolute directory the command runs in. */
  readonly cwd: string
  /** Absolute workspace root; writes outside it are never the agent's to make. */
  readonly workspace: string
  /**
   * Other spellings of the workspace root, such as its resolved path when the
   * recorded one passes through a symbolic link. A path under any of them is
   * in the workspace.
   */
  readonly workspaceAliases: readonly string[]
  /**
   * Absolute roots where destroying files is expected, such as a scratch
   * directory. A root that encloses the workspace does not make the workspace
   * expendable.
   */
  readonly temporaryRoots: readonly string[]
  /** Rule ids the deployment downgraded to `allow`. */
  readonly allow: readonly string[]
  /** Extra argv prefixes to deny, each already split into words. */
  readonly denyExtra: readonly (readonly string[])[]
  /**
   * Whether an absolute path names an existing file or directory. The
   * classifier asks only to tell a `git checkout` path from a branch name, so
   * it never reads the disk itself.
   */
  readonly exists: (path: string) => boolean
}

/** One blocked attempt, kept for `/commands-gate` and logged to the session. */
export interface BlockedAttempt {
  /** Tool whose call was blocked. */
  readonly tool: string
  /** The command line as the model wrote it. */
  readonly command: string
  readonly rule: string
  readonly verdict: Extract<CommandVerdict, 'confirm' | 'deny'>
  readonly reason: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A shell command the gate refused, recorded so the refusal is
     * reconstructable from the log alone. Log-only: it carries no surface
     * operation and adds no model history of its own, because the denial
     * already reaches the model as the tool's error result.
     * @param tool - tool whose call was refused.
     * @param command - the command line as written.
     * @param rule - the rule id that matched.
     * @param verdict - whether the rule denied outright or a confirmation failed.
     * @param reason - the sentence the model received.
     */
    'command-gate/blocked': BlockedAttempt
  }
}
