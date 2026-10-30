/**
 * The rule table. Each rule reads parsed argv and answers for one command in
 * one working directory; a command's verdict is the worst any rule gave it in
 * any directory it may run in, and the line's verdict is the worst its
 * commands produced.
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

/** Programs that create or overwrite each path they name. */
const WRITERS = new Set(['mv', 'cp', 'tee', 'truncate', 'install', 'ln', 'rsync', 'touch', 'mkdir'])

/** `find` actions that run the command written after them on each match. */
const FIND_RUNNERS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

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

/** Where a refused delete or write may go instead, shared by the outside-the-workspace reasons. */
const INSTEAD = 'inside the workspace or a temporary directory such as `/tmp`.'

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
 * Classify where a path operand would write. The narrower root decides: a
 * temporary root at or inside the workspace marks scratch space, while one
 * that encloses the workspace, such as `/tmp` around a workspace under it,
 * leaves the workspace protected.
 * @param operand - the path as written.
 * @param context - workspace, working directory, and temporary roots.
 * @returns which region the operand belongs to.
 */
function placement(operand: string, context: CommandContext): Placement {
  const path = resolvePath(context.cwd, operand)
  const workspaces = [context.workspace, ...context.workspaceAliases]
  const inWorkspace = workspaces.some(workspace => within(path, workspace))
  const temporary = context.temporaryRoots
    .map(root => resolvePath(context.cwd, root))
    .some(root => within(path, root) && (!inWorkspace || workspaces.some(workspace => within(root, workspace))))
  if (temporary) return 'temporary'
  return inWorkspace ? 'workspace' : 'outside'
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

/**
 * A refusal or question whose reason names the command gate, so the model
 * does not take it for the sandbox.
 * @param verdict - what the gate does with the command.
 * @param rule - the stable rule id.
 * @param text - what the command would do and what to do instead.
 * @returns the classification.
 */
function classified(verdict: Exclude<CommandVerdict, 'allow'>, rule: string, text: string): Classification {
  return { verdict, rule, reason: `Command gate: ${text}` }
}

/** The refusal of a delete that reaches past the workspace and temporary roots. */
function deleteOutside(): Classification {
  return classified('deny', 'rm-destructive', `this deletes files outside the workspace. Delete only ${INSTEAD}`)
}

/** One `git` command: its subcommand, the words after it, and where `-C` moved it. */
interface GitCommand {
  readonly subcommand: string
  readonly rest: readonly string[]
  /** Absolute directory git runs in once every `-C` before the subcommand applies. */
  readonly directory: string
}

/**
 * Read a `git` command: skip its global options and the value of `-c`, follow
 * each `-C dir`, and find the subcommand.
 * @param command - the simple command under test.
 * @param cwd - the directory the command runs in.
 * @returns the parsed command, or `undefined` for another program or a bare `git`.
 */
function gitCommand(command: SimpleCommand, cwd: string): GitCommand | undefined {
  if (basename(command.argv[0]) !== 'git') return undefined
  let directory = cwd
  for (let index = 1; index < command.argv.length; index += 1) {
    const word = command.argv[index] as string
    if (word === '-c') {
      index += 1
      continue
    }
    if (word === '-C') {
      const value = command.argv[index + 1]
      if (value === undefined) return undefined
      directory = resolvePath(directory, value)
      index += 1
      continue
    }
    if (word.startsWith('-')) continue
    return { subcommand: word, rest: command.argv.slice(index + 1), directory }
  }
  return undefined
}

/**
 * Whether git options include one of the given ones, written long, long with
 * `=value`, or as a letter in a short bundle such as `-qf`. A bundle ends at the
 * first letter that takes a value, because the rest of the word is that value:
 * `-bfix` names the branch `fix`.
 * @param words - the option words to search.
 * @param letters - short option letters that match.
 * @param longs - long options that match.
 * @param valued - short option letters that take a value.
 * @returns true when one of the options is present.
 */
function gitOption(words: readonly string[], letters: string, longs: readonly string[], valued: string): boolean {
  return words.some((word) => {
    if (longs.some(long => word === long || word.startsWith(`${long}=`))) return true
    if (!word.startsWith('-') || word.startsWith('--')) return false
    for (const letter of word.slice(1)) {
      if (letters.includes(letter)) return true
      if (valued.includes(letter)) return false
    }
    return false
  })
}

/**
 * Whether a `git checkout` operand can only be a path. No branch name starts
 * with `/` or `.`, ends with `/`, or holds a glob character, and a leading `:`
 * is pathspec magic.
 * @param operand - the operand as written.
 * @returns true when no branch can have that name.
 */
function pathOnly(operand: string): boolean {
  return operand.startsWith('/') || operand.startsWith('.') || operand.startsWith(':') || operand.endsWith('/') || GLOB.test(operand)
}

/**
 * The options of a git subcommand: its words before `--`, after which every
 * word is a path.
 * @param rest - the words after the subcommand.
 * @returns the words before `--`, or all of them when there is none.
 */
function gitOptions(rest: readonly string[]): readonly string[] {
  const separator = rest.indexOf('--')
  return separator === -1 ? rest : rest.slice(0, separator)
}

/**
 * The question for a git command forced to overwrite the working tree.
 * @param command - the subcommand and option as shown, such as `checkout --force`.
 * @returns the confirm classification.
 */
function forcedDiscard(command: string): Classification {
  return classified('confirm', 'git-discard-worktree',
    `\`git ${command}\` discards any uncommitted edits in the working tree. Commit or stash first.`)
}

/**
 * Judge `git checkout`, which overwrites working-tree files when forced or
 * given a path. A bare operand that names an existing file or directory is a
 * path; one that does not is a branch, and switching branches keeps edits.
 * @param git - the parsed git command.
 * @param context - the filesystem check.
 * @returns a confirm verdict when the command can discard edits, else `undefined`.
 */
function gitCheckout(git: GitCommand, context: CommandContext): Classification | undefined {
  const options = gitOptions(git.rest)
  if (gitOption(options, 'f', ['--force'], 'bB')) return forcedDiscard('checkout --force')
  if (gitOption(options, 'bB', ['--orphan'], '')) return undefined
  const paths = options.length < git.rest.length - 1
    || gitOption(options, '', ['--pathspec-from-file'], '')
    || options.some(word => !word.startsWith('-') && (pathOnly(word) || context.exists(resolvePath(git.directory, word))))
  if (!paths) return undefined
  return classified('confirm', 'git-discard-worktree', '`git checkout` on a path overwrites it, discarding any uncommitted '
    + 'edits to it. Commit or stash first, or use `git switch` to change branches.')
}

/** One rule's answer, or undefined when the rule does not apply. */
type Rule = (command: SimpleCommand, context: CommandContext) => Classification | undefined

/** The rule table; among answers of equal severity, the earlier rule names the verdict. */
const RULES: readonly Rule[] = [
  function remoteScriptExecution(command) {
    const program = basename(command.argv[0])
    if (!FETCHERS.has(program) || command.pipesInto === undefined) return undefined
    if (!INTERPRETERS.has(basename(command.pipesInto))) return undefined
    return classified('deny', 'remote-script-execution',
      'piping a download into an interpreter runs code nobody has read. Save it to a file, read it, then run it.')
  },

  function machinePower(command) {
    const program = basename(command.argv[0])
    if (!['shutdown', 'reboot', 'halt', 'poweroff'].includes(program)) return undefined
    return classified('deny', 'machine-power', `\`${program}\` would stop the machine, ending this session. No task needs it.`)
  },

  function diskWrite(command) {
    const program = basename(command.argv[0])
    if (program === 'dd' || program.startsWith('mkfs')) {
      return classified('deny', 'disk-write', `\`${program}\` writes raw devices and can destroy a filesystem. Use ordinary file tools instead.`)
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
    return classified('deny', 'global-package-install', `a global \`${program}\` install changes the machine for every project. `
      + 'Add the dependency to this project, or ask the user to install it.')
  },

  function rmDestructive(command, context) {
    if (basename(command.argv[0]) !== 'rm') return undefined
    // Under `xargs` more paths arrive on standard input, so the line does not name them all.
    const unknownTargets = command.argumentsFromInput === true
    if (!unknownTargets && !hasFlag(command, 'rRf', ['--recursive', '--force'])) return undefined
    const places = operands(command).map(target => placement(target, context))
    if (places.includes('outside')) return deleteOutside()
    if (unknownTargets) {
      return classified('confirm', 'rm-destructive',
        '`xargs rm` deletes paths that are not known until it runs. List them first, then remove them by name.')
    }
    if (places.every(place => place === 'temporary')) return undefined
    return classified('confirm', 'rm-destructive', '`rm -r`/`-f` in the workspace cannot be undone for any file that was never committed. '
      + 'Commit first, or remove exact paths without `-r`/`-f`.')
  },

  function findDeletion(command, context) {
    if (basename(command.argv[0]) !== 'find') return undefined
    const words = command.argv.slice(1)
    const deletes = words.some((word, index) => word === '-delete'
      || (FIND_RUNNERS.has(word) && basename(words[index + 1] ?? '') === 'rm'))
    if (!deletes) return undefined
    // The starting paths come before the expression, after any `-H`, `-L`, or
    // `-P`; without one, `find` starts from the current directory.
    const roots: string[] = []
    for (const word of words) {
      if (roots.length === 0 && /^-[HLP]$/.test(word)) continue
      if (word.startsWith('-') || word === '!' || word === '(') break
      roots.push(word)
    }
    const places = (roots.length === 0 ? ['.'] : roots).map(root => placement(root, context))
    if (places.includes('outside')) return deleteOutside()
    if (places.every(place => place === 'temporary')) return undefined
    return classified('confirm', 'rm-destructive', 'deleting with `find` in the workspace cannot be undone for any file that was never committed. '
      + 'Commit first, or remove exact paths with `rm`.')
  },

  function writeOutsideWorkspace(command, context) {
    const program = basename(command.argv[0])
    if (!WRITERS.has(program)) return undefined
    const targets = operands(command)
    // For a copy or move the destination is the last operand; for the rest
    // every operand is written.
    const written = ['mv', 'cp', 'rsync'].includes(program) ? targets.slice(-1) : targets
    if (!written.some(target => placement(target, context) === 'outside')) return undefined
    return classified('deny', 'write-outside-workspace', `\`${program}\` would write outside the workspace. Write ${INSTEAD}`)
  },

  function gitRules(command, context) {
    const git = gitCommand(command, context.cwd)
    if (git === undefined) return undefined
    const { subcommand, rest } = git
    switch (subcommand) {
      case 'reset':
        if (!rest.includes('--hard')) return undefined
        return classified('confirm', 'git-reset-hard',
          '`git reset --hard` discards every uncommitted change in the working tree. Commit or stash first.')
      case 'checkout':
        return gitCheckout(git, context)
      case 'switch':
        if (!gitOption(gitOptions(rest), 'f', ['--force', '--discard-changes'], 'cC')) return undefined
        return forcedDiscard('switch --discard-changes')
      case 'restore': {
        // `--staged` alone resets only the index; the working tree keeps its edits.
        const options = gitOptions(rest)
        if (gitOption(options, 'S', ['--staged'], 's') && !gitOption(options, 'W', ['--worktree'], 's')) return undefined
        return classified('confirm', 'git-discard-worktree',
          '`git restore` overwrites working-tree files, discarding any uncommitted edits to them. Commit or stash first.')
      }
      case 'stash': {
        const action = rest.find(word => !word.startsWith('-'))
        if (action !== 'drop' && action !== 'clear') return undefined
        return classified('confirm', 'git-stash-drop',
          `\`git stash ${action}\` deletes stashed changes, which no branch holds. Apply what you need first, or ask the user.`)
      }
      case 'clean':
        if (!hasFlag(command, 'fdx', ['--force'])) return undefined
        return classified('confirm', 'git-clean',
          '`git clean` deletes untracked files, which no commit holds. Run `git clean -n` first to see what it would remove.')
      case 'push': {
        const forced = rest.some(word => word === '--force' || word === '-f' || word.startsWith('--force-with-lease'))
          || rest.some(word => word.startsWith('+') && word.length > 1)
        if (!forced) return undefined
        return classified('confirm', 'git-force-push',
          'a force push replaces the remote branch and can drop commits others rely on. Push normally, or ask the user first.')
      }
      case 'rebase':
        if (rest.some(word => ['--abort', '--quit', '--continue', '--skip'].includes(word))) return undefined
        return classified('confirm', 'git-history-rewrite', '`git rebase` rewrites existing commits. Prefer a merge, or ask the user first.')
      case 'filter-branch':
      case 'reflog':
        if (subcommand === 'reflog' && !rest.includes('expire')) return undefined
        return classified('confirm', 'git-history-rewrite', `\`git ${subcommand}\` rewrites or drops history. Ask the user first.`)
      // Every other subcommand keeps the working tree and history.
      default:
        return undefined
    }
  },

  function recursivePermissions(command) {
    const program = basename(command.argv[0])
    if (program !== 'chmod' && program !== 'chown') return undefined
    if (!hasFlag(command, 'R', ['--recursive'])) return undefined
    return classified('confirm', program === 'chmod' ? 'chmod-recursive' : 'chown-recursive',
      `a recursive \`${program}\` changes a whole tree at once. Name the exact files instead.`)
  },

  function inplaceEdit(command) {
    const program = basename(command.argv[0])
    if (program !== 'sed' && program !== 'perl') return undefined
    const inPlace = command.argv.slice(1).some(word => word === '-i' || word.startsWith('-i.') || /^-[a-z]*i[a-z]*$/.test(word))
    if (!inPlace) return undefined
    const files = operands(command).slice(program === 'sed' ? 1 : 0)
    const many = files.length > 1 || files.some(file => GLOB.test(file))
    if (!many) return undefined
    return classified('confirm', 'inplace-edit-many',
      `an in-place \`${program}\` across several files changes them all at once. Edit them with the file tools instead.`)
  },

  function redirectOutsideWorkspace(command, context) {
    for (const redirection of command.redirections) {
      if (redirection.operator === '<' || NULL_SINKS.has(redirection.target)) continue
      // Only the destination matters. A `>` or `>>` inside the workspace is
      // ordinary work — writing a script, capturing build output — and cannot
      // be told apart from clobbering a source file without reading the disk,
      // so flagging every one of them would stop far more real work than it saves.
      if (placement(redirection.target, context) !== 'outside') continue
      return classified('deny', 'write-outside-workspace',
        `redirecting into \`${redirection.target}\` writes outside the workspace. Write ${INSTEAD}`)
    }
    return undefined
  },
]

/**
 * Classify one already-parsed command in every directory it may run in.
 * @param command - the simple command under test.
 * @param context - workspace, temporary roots, filesystem check, and
 *   configured overrides; `cwd` is where the command's line starts.
 * @returns the worst classification any rule gave, or an allow when none applies.
 */
export function classifyCommand(command: SimpleCommand, context: CommandContext): Classification {
  const words = command.argv
  for (const prefix of context.denyExtra) {
    if (prefix.length > 0 && prefix.every((word, index) => words[index] === word)) {
      return classified('deny', 'deny-extra', `\`${prefix.join(' ')}\` is blocked by this deployment's command policy.`)
    }
  }
  const directories = new Set((command.directories ?? [[]]).map(chain => chain.reduce(resolvePath, context.cwd)))
  let worst = allowed()
  for (const cwd of directories) {
    for (const rule of RULES) {
      const found = rule(command, { ...context, cwd })
      // An allowed rule steps aside; the other rules still judge the command.
      if (found === undefined || context.allow.includes(found.rule)) continue
      if (SEVERITY[found.verdict] > SEVERITY[worst.verdict]) worst = found
    }
  }
  return worst
}

/** The neutral classification every unmatched command gets. */
function allowed(): Classification {
  return { verdict: 'allow', rule: 'none', reason: '' }
}

/**
 * Classify a whole command line: parse it, judge each command it would run,
 * and answer with the worst verdict found.
 * @param line - the command line as the model wrote it.
 * @param context - workspace, temporary roots, filesystem check, and
 *   configured overrides.
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
