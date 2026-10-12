/**
 * The rule table. Each rule reads parsed argv and answers for one command;
 * the line's verdict is the worst its commands produced.
 *
 * Two severities, drawn from what can be recovered afterwards. A command that
 * destroys uncommitted work or rewrites history inside the workspace is
 * `confirm`: a person may well want it, and no commit can undo it
 * because the loss is of work no commit holds. A command that writes outside
 * the workspace, reprograms the machine, or runs code fetched from the network
 * is `deny`: no agent round needs it, and a sandbox set to
 * `danger-full-access` for an unattended run would not stop it.
 * @module
 */

import { basename, parseCommandLine } from './parse.ts'
import type { Classification, CommandContext, CommandVerdict, SimpleCommand } from './types.ts'

/** Ranking used to fold a line's commands into one answer. */
const SEVERITY: Record<CommandVerdict, number> = { allow: 0, confirm: 1, deny: 2 }

/** Redirection targets that discard rather than write. */
const NULL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

/** Programs whose job is to run whatever arrives on standard input. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby'])

/** Fetchers whose output is code when piped into an interpreter. */
const FETCHERS = new Set(['curl', 'wget'])

/** Package managers whose global mode installs outside the workspace. */
const GLOBAL_INSTALLERS: Record<string, readonly string[]> = {
  npm: ['install', 'i', 'add'],
  pnpm: ['add', 'install'],
  yarn: ['global'],
  bun: ['add', 'install'],
  pip: ['install'],
  pip3: ['install'],
  gem: ['install'],
  cargo: ['install'],
  go: ['install'],
  brew: ['install'],
  apt: ['install'],
  'apt-get': ['install'],
  dnf: ['install'],
  yum: ['install'],
  pacman: ['-S'],
  apk: ['add'],
}

/** Glob metacharacters that make one operand stand for many files. */
const GLOB = /[*?[]/

/**
 * Join a path against the command's directory without touching the disk.
 * @param cwd - absolute directory the command runs in.
 * @param operand - a path as written, absolute or relative.
 * @returns the operand as an absolute, normalized path.
 */
export function resolvePath(cwd: string, operand: string): string {
  const raw = operand.startsWith('/') ? operand : `${cwd}/${operand}`
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * Whether a resolved path sits at or beneath a root.
 * @param path - the absolute path under test.
 * @param root - the absolute root.
 * @returns true when the path is the root or inside it.
 */
export function within(path: string, root: string): boolean {
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root
  return path === normalized || path.startsWith(`${normalized}/`)
}

/** Where one operand lands relative to the places that matter. */
type Placement = 'temporary' | 'workspace' | 'outside'

/**
 * Classify where a path operand would write.
 * @param operand - the path as written.
 * @param context - workspace, working directory, and temporary roots.
 * @returns which region the operand belongs to.
 */
function placement(operand: string, context: CommandContext): Placement {
  const path = resolvePath(context.cwd, operand)
  if (context.temporaryRoots.some(root => within(path, resolvePath(context.cwd, root)))) return 'temporary'
  return within(path, context.workspace) ? 'workspace' : 'outside'
}

/** Operands of a command: every word that is not a flag. */
function operands(command: SimpleCommand): string[] {
  return command.argv.slice(1).filter(word => !word.startsWith('-'))
}

/** Whether any of a command's flags matches one of the given short or long forms. */
function hasFlag(command: SimpleCommand, shorts: string, longs: readonly string[]): boolean {
  return command.argv.slice(1).some((word) => {
    if (longs.includes(word)) return true
    if (!word.startsWith('-') || word.startsWith('--')) return false
    return word.slice(1).split('').some(letter => shorts.includes(letter))
  })
}

/** The git subcommand, skipping `-C dir` and similar leading options. */
function gitSubcommand(command: SimpleCommand): string | undefined {
  for (let index = 1; index < command.argv.length; index += 1) {
    const word = command.argv[index] as string
    if (word === '-C' || word === '-c') {
      index += 1
      continue
    }
    if (word.startsWith('-')) continue
    return word
  }
  return undefined
}

/** One rule's answer, or undefined when the rule does not apply. */
type Rule = (command: SimpleCommand, context: CommandContext) => Classification | undefined

/** The ordered rule table; the first match wins for a given command. */
const RULES: readonly Rule[] = [
  function remoteScriptExecution(command) {
    const program = basename(command.argv[0])
    if (!FETCHERS.has(program) || command.pipesInto === undefined) return undefined
    if (!INTERPRETERS.has(basename(command.pipesInto))) return undefined
    return {
      verdict: 'deny',
      rule: 'remote-script-execution',
      reason: 'Piping a download straight into an interpreter runs code nobody has read. '
        + 'Download the script to a file, read it, then run it if it is what you expect.',
    }
  },

  function machinePower(command) {
    const program = basename(command.argv[0])
    if (!['shutdown', 'reboot', 'halt', 'poweroff'].includes(program)) return undefined
    return {
      verdict: 'deny',
      rule: 'machine-power',
      reason: `\`${program}\` would end this session and every other program on the machine. It is never part of a task.`,
    }
  },

  function diskWrite(command) {
    const program = basename(command.argv[0])
    if (program === 'dd' || program.startsWith('mkfs')) {
      return {
        verdict: 'deny',
        rule: 'disk-write',
        reason: `\`${program}\` writes raw devices and can destroy the filesystem. Use ordinary file tools inside the workspace.`,
      }
    }
    return undefined
  },

  function globalPackageInstall(command) {
    // A bare `sudo` leaves no program, so this list may be empty.
    const argv: readonly string[] = command.argv[0] === 'sudo' ? command.argv.slice(1) : command.argv
    const program = basename(argv[0] ?? '')
    const subcommands = GLOBAL_INSTALLERS[program]
    if (subcommands === undefined) return undefined
    const rest = argv.slice(1)
    const subcommand = rest.find(word => !word.startsWith('-'))
    if (subcommand === undefined || !subcommands.includes(subcommand)) return undefined
    const systemManager = ['apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk', 'brew'].includes(program)
    const global = systemManager
      || command.argv[0] === 'sudo'
      || rest.some(word => word === '-g' || word === '--global' || word === '--location=global')
      || (program === 'yarn' && subcommand === 'global')
      || ['cargo', 'gem', 'go'].includes(program)
    if (!global) return undefined
    return {
      verdict: 'deny',
      rule: 'global-package-install',
      reason: `Installing \`${program}\` packages outside the workspace changes the machine for every other project. `
        + 'Add the dependency to this project instead, or ask the user to install it.',
    }
  },

  function rmDestructive(command, context) {
    if (basename(command.argv[0]) !== 'rm') return undefined
    if (!hasFlag(command, 'rRf', ['--recursive', '--force'])) return undefined
    const targets = operands(command)
    if (targets.length === 0) return undefined
    const places = targets.map(target => placement(target, context))
    if (places.every(place => place === 'temporary')) return undefined
    if (places.some(place => place === 'outside')) {
      return {
        verdict: 'deny',
        rule: 'rm-destructive',
        reason: 'This would delete files outside the workspace, which no task needs. '
          + 'Delete inside the workspace, or use a temporary directory.',
      }
    }
    return {
      verdict: 'confirm',
      rule: 'rm-destructive',
      reason: 'A recursive or forced delete removes files no commit holds, so no commit can bring them back. '
        + 'Commit what matters first, or delete the exact paths without `-r`/`-f`.',
    }
  },

  function writeOutsideWorkspace(command, context) {
    const program = basename(command.argv[0])
    if (!['mv', 'cp', 'tee', 'truncate', 'install', 'ln', 'rsync'].includes(program)) return undefined
    const targets = operands(command)
    // For a copy or move the destination is the last operand; for the rest
    // every operand is written.
    const written = ['mv', 'cp', 'rsync'].includes(program) ? targets.slice(-1) : targets
    if (!written.some(target => placement(target, context) === 'outside')) return undefined
    return {
      verdict: 'deny',
      rule: 'write-outside-workspace',
      reason: `\`${program}\` would write outside the workspace, where nothing can undo it. Keep the destination inside the workspace.`,
    }
  },

  function gitRules(command) {
    if (basename(command.argv[0]) !== 'git') return undefined
    const subcommand = gitSubcommand(command)
    if (subcommand === undefined) return undefined
    const rest = command.argv.slice(command.argv.indexOf(subcommand) + 1)
    if (subcommand === 'reset' && rest.includes('--hard')) {
      return {
        verdict: 'confirm',
        rule: 'git-reset-hard',
        reason: '`git reset --hard` throws away every uncommitted change, which no commit holds. '
          + 'Commit or stash first.',
      }
    }
    if (subcommand === 'checkout' || subcommand === 'restore') {
      // `-b`, `--staged`, and a bare branch switch keep the working tree.
      if (rest.includes('-b') || rest.includes('-B') || rest.includes('--staged')) return undefined
      const discards = rest.includes('--') || rest.some(word => word === '.' || word.includes('/') || word.endsWith('.ts'))
      if (subcommand === 'restore' ? true : discards) {
        return {
          verdict: 'confirm',
          rule: 'git-discard-worktree',
          reason: `\`git ${subcommand}\` on a path discards uncommitted edits to it, which no commit holds. `
            + 'Commit them first if they matter.',
        }
      }
      return undefined
    }
    if (subcommand === 'clean' && hasFlag(command, 'fdx', ['--force'])) {
      return {
        verdict: 'confirm',
        rule: 'git-clean',
        reason: '`git clean` deletes untracked files, including new work that was never committed. '
          + 'Run it with `-n` first to see what would go.',
      }
    }
    if (subcommand === 'push') {
      const forced = rest.some(word => word === '--force' || word === '-f' || word.startsWith('--force-with-lease'))
        || rest.some(word => word.startsWith('+') && word.length > 1)
      if (forced) {
        return {
          verdict: 'confirm',
          rule: 'git-force-push',
          reason: 'A force push rewrites what the remote holds and can destroy commits others rely on. '
            + 'Push normally, or ask the user before rewriting a published branch.',
        }
      }
      return undefined
    }
    if (subcommand === 'rebase' && !rest.some(word => ['--abort', '--quit', '--continue', '--skip'].includes(word))) {
      return {
        verdict: 'confirm',
        rule: 'git-history-rewrite',
        reason: '`git rebase` rewrites commits, so a commit recorded against the old history no longer applies. '
          + 'Prefer a merge, or ask the user first.',
      }
    }
    if (subcommand === 'filter-branch' || (subcommand === 'reflog' && rest.includes('expire'))) {
      return {
        verdict: 'confirm',
        rule: 'git-history-rewrite',
        reason: `\`git ${subcommand}\` rewrites or drops history that no later commit can restore.`,
      }
    }
    return undefined
  },

  function recursivePermissions(command) {
    const program = basename(command.argv[0])
    if (program !== 'chmod' && program !== 'chown') return undefined
    if (!hasFlag(command, 'R', ['--recursive'])) return undefined
    return {
      verdict: 'confirm',
      rule: program === 'chmod' ? 'chmod-recursive' : 'chown-recursive',
      reason: `A recursive \`${program}\` rewrites permissions across a whole tree and is easy to get wrong. `
        + 'Name the exact files instead.',
    }
  },

  function inplaceEdit(command) {
    const program = basename(command.argv[0])
    if (program !== 'sed' && program !== 'perl') return undefined
    const inPlace = command.argv.slice(1).some(word => word === '-i' || word.startsWith('-i.') || /^-[a-z]*i[a-z]*$/.test(word))
    if (!inPlace) return undefined
    const files = operands(command).slice(program === 'sed' ? 1 : 0)
    const many = files.length > 1 || files.some(file => GLOB.test(file))
    if (!many) return undefined
    return {
      verdict: 'confirm',
      rule: 'inplace-edit-many',
      reason: `An in-place \`${program}\` across several files rewrites each one with no copy of what it replaced. `
        + 'Edit the files through the file tools, which record what changed.',
    }
  },

  function truncatingRedirect(command, context) {
    for (const redirection of command.redirections) {
      if (redirection.operator !== '>') continue
      if (NULL_SINKS.has(redirection.target)) continue
      // Only the destination matters. A `>` inside the workspace is ordinary
      // work — writing a script, capturing build output — and cannot be told
      // apart from clobbering a source file without reading the disk, so
      // flagging every one of them would stop far more real work than it saves.
      if (placement(redirection.target, context) !== 'outside') continue
      return {
        verdict: 'deny',
        rule: 'write-outside-workspace',
        reason: `Redirecting output to \`${redirection.target}\` writes outside the workspace. Keep the target inside it.`,
      }
    }
    return undefined
  },
]

/**
 * Classify one already-parsed command.
 * @param command - the simple command under test.
 * @param context - workspace, temporary roots, and configured overrides.
 * @returns the matching classification, or an allow when no rule applies.
 */
export function classifyCommand(command: SimpleCommand, context: CommandContext): Classification {
  const words = command.argv
  for (const prefix of context.denyExtra) {
    if (prefix.length > 0 && prefix.every((word, index) => words[index] === word)) {
      return {
        verdict: 'deny',
        rule: 'deny-extra',
        reason: `\`${prefix.join(' ')}\` is blocked by this deployment's command policy.`,
      }
    }
  }
  for (const rule of RULES) {
    const found = rule(command, context)
    if (found === undefined) continue
    if (context.allow.includes(found.rule)) return allowed()
    return found
  }
  return allowed()
}

/** The neutral classification every unmatched command gets. */
function allowed(): Classification {
  return { verdict: 'allow', rule: 'none', reason: '' }
}

/**
 * Classify a whole command line: parse it, judge each command it would run,
 * and answer with the worst verdict found.
 * @param line - the command line as the model wrote it.
 * @param context - workspace, temporary roots, and configured overrides.
 * @returns the line's classification.
 */
export function classifyCommandLine(line: string, context: CommandContext): Classification {
  let worst = allowed()
  for (const command of parseCommandLine(line)) {
    const found = classifyCommand(command, context)
    if (SEVERITY[found.verdict] > SEVERITY[worst.verdict]) worst = found
  }
  return worst
}
