/**
 * Shell-line parsing sufficient to classify what will actually run. A rule
 * reads argv, never the raw string, so a destructive command cannot hide
 * behind `&&`, a pipeline, a subshell, a compound command such as `if` or
 * `for`, `$( )`, or a `sh -c` or `eval` payload.
 *
 * This is not a shell. It resolves quoting, escapes, line continuations,
 * operators, redirections, and the nesting forms listed above, and it records
 * where a literal `cd` moves the commands after it; it does not expand
 * variables or globs, and a word that came from `$VAR` reaches the classifier
 * unexpanded. A rule therefore treats an unresolvable operand as unknown
 * rather than safe.
 * @module
 */

import type { Redirection, SimpleCommand } from './types.ts'

/** One word plus whether the source quoted or escaped it, so operators stay literal. */
interface Word {
  readonly text: string
  readonly quoted: boolean
}

/** A `$( )` or backtick payload and the index of the token it appears in. */
interface Substitution {
  readonly line: string
  readonly token: number
}

/** Operators that end a simple command. */
const OPERATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

/**
 * Operators after which a later command can run although a `cd` earlier in
 * the same `&&` chain failed.
 */
const CHAIN_BREAKS = new Set(['||', ';', '&', '\n'])

/**
 * Reserved words that negate a pipeline or open, continue, or close a
 * compound command such as `if`, `while`, `for … do`, or `{ }`. In command
 * position they are syntax, so the word after them is the program.
 */
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac'])

/** One possible working directory: the `cd` targets that lead to it, in order. */
type Chain = readonly string[]

/** Every working directory a command may run in. */
type Directories = readonly Chain[]

/** The directories of a command that runs where its line starts. */
const START: Directories = [[]]

/**
 * How many possible working directories one line keeps. Each `cd` whose
 * success the line leaves open doubles them, so past this bound the parser
 * stops following later `cd` commands rather than growing without limit.
 */
const MAX_DIRECTORIES = 16

/** Shells whose `-c` argument is another command line. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])

/**
 * The descriptor after a `>&` or `<&`: digits or `-` forming a whole word,
 * which duplicates or closes a stream instead of naming a file.
 */
const DESCRIPTOR = /^\s*(?:\d+|-)(?![^\s;&|<>()])/

/** A `NAME=value` word, which is an environment assignment when it precedes the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The escapes a double-quoted word resolves; any other backslash stays literal. */
const DOUBLE_QUOTED_ESCAPE = /\\([\\"$`])/g

/** How a program that runs another command lays out its own words before that command. */
interface Wrapper {
  /** Options that take the next word as their value. */
  readonly valued: ReadonlySet<string>
  /** Positional words, such as `timeout`'s duration, between the options and the command. */
  readonly positional: number
  /** Whether `NAME=value` words before the command set its environment, as `env` reads them. */
  readonly assignments: boolean
  /** Options whose value is a whole command line, as `env -S` takes one. */
  readonly lineOptions: ReadonlySet<string>
}

/** The option set of a wrapper that takes no command-line option. */
const NO_LINE_OPTIONS: ReadonlySet<string> = new Set()

/**
 * Programs that run the command following their own options. The gate
 * classifies that command as well, so a wrapper cannot hide it.
 */
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  sudo: {
    valued: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U',
      '--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--command-timeout', '--other-user']),
    positional: 0,
    assignments: true,
    lineOptions: NO_LINE_OPTIONS,
  },
  doas: { valued: new Set(['-u', '-C']), positional: 0, assignments: false, lineOptions: NO_LINE_OPTIONS },
  env: {
    valued: new Set(['-u', '--unset', '-C', '--chdir']),
    positional: 0,
    assignments: true,
    lineOptions: new Set(['-S', '--split-string']),
  },
  nice: { valued: new Set(['-n', '--adjustment']), positional: 0, assignments: false, lineOptions: NO_LINE_OPTIONS },
  nohup: { valued: new Set(), positional: 0, assignments: false, lineOptions: NO_LINE_OPTIONS },
  timeout: {
    valued: new Set(['-s', '--signal', '-k', '--kill-after']),
    positional: 1,
    assignments: false,
    lineOptions: NO_LINE_OPTIONS,
  },
  time: { valued: new Set(['-f', '--format', '-o', '--output']), positional: 0, assignments: false, lineOptions: NO_LINE_OPTIONS },
  stdbuf: {
    valued: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
    positional: 0,
    assignments: false,
    lineOptions: NO_LINE_OPTIONS,
  },
  xargs: {
    valued: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-e', '-I', '-L', '-l',
      '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']),
    positional: 0,
    assignments: false,
    lineOptions: NO_LINE_OPTIONS,
  },
  command: { valued: new Set(), positional: 0, assignments: false, lineOptions: NO_LINE_OPTIONS },
  exec: { valued: new Set(['-a']), positional: 0, assignments: false, lineOptions: NO_LINE_OPTIONS },
}

/**
 * The command a wrapper program runs: its argument words after the wrapper's
 * own options, their values, positional words, and leading assignments, or a
 * command line `env -S` passes as one string.
 * @param argv - the wrapper command's words.
 * @returns the wrapped command's words, a command line to parse, or `undefined`
 *   when the program is no wrapper or wraps nothing.
 */
function wrappedCommand(
  argv: readonly [string, ...string[]],
): { readonly argv: readonly [string, ...string[]] } | { readonly line: string } | undefined {
  const wrapper = WRAPPERS[basename(argv[0])]
  if (wrapper === undefined) return undefined
  let index = 1
  let positional = wrapper.positional
  for (; index < argv.length; index += 1) {
    const word = argv[index] as string
    if (word === '--') {
      index += 1
      break
    }
    if (wrapper.lineOptions.has(word)) {
      const line = argv[index + 1]
      return line === undefined ? undefined : { line }
    }
    const equals = word.indexOf('=')
    if (word.startsWith('--') && equals !== -1 && wrapper.lineOptions.has(word.slice(0, equals))) return { line: word.slice(equals + 1) }
    if (word.length > 1 && word.startsWith('-')) {
      if (wrapper.valued.has(word)) index += 1
      continue
    }
    if (wrapper.assignments && ASSIGNMENT.test(word)) continue
    if (positional > 0) {
      positional -= 1
      continue
    }
    break
  }
  while (wrapper.assignments && index < argv.length && ASSIGNMENT.test(argv[index] as string)) index += 1
  const [program, ...rest] = argv.slice(index)
  return program === undefined ? undefined : { argv: [program, ...rest] }
}

/**
 * The program a command finally runs once its wrappers are looked through,
 * so a pipe into `sudo bash` counts as a pipe into `bash`.
 * @param argv - the command's words.
 * @returns the innermost program word.
 */
function effectiveProgram(argv: readonly [string, ...string[]]): string {
  const inner = wrappedCommand(argv)
  return inner === undefined || 'line' in inner ? argv[0] : effectiveProgram(inner.argv)
}

/** A `-c` flag, alone or bundled with login/interactive letters such as `-lc`. */
function isDashC(word: string): boolean {
  return /^-[a-z]*c$/.test(word)
}

/**
 * Split a line into words and operators, honouring single quotes, double
 * quotes, backslash escapes, and line continuations, and collecting nested
 * `$( )` and backtick payloads for separate parsing.
 * @param line - the raw command line.
 * @returns the words and operators in order, a subshell's `(` and `)` among
 *   them, plus every nested payload found with the token it belongs to.
 */
function tokenize(line: string): { tokens: Word[]; nested: Substitution[] } {
  const tokens: Word[] = []
  const nested: Substitution[] = []
  let current = ''
  let started = false
  let quoted = false
  const push = (): void => {
    if (started) tokens.push({ text: current, quoted })
    current = ''
    started = false
    quoted = false
  }
  // The word being built becomes the next token, so its payloads carry that index.
  const substitute = (payload: string): void => {
    nested.push({ line: payload, token: tokens.length })
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    if (char === '\\') {
      const next = line[index + 1]
      index += 1
      // A backslash before a newline joins the two lines; before anything
      // else it makes the character literal, so `\;` is a word, not an operator.
      if (next === undefined || next === '\n') continue
      current += next
      started = true
      quoted = true
      continue
    }
    if (char === "'" || char === '"') {
      const end = closingQuote(line, index)
      const body = line.slice(index + 1, end)
      if (char === '"') {
        // A double-quoted `$( )` or backtick substitution still runs; a
        // single-quoted one does not.
        for (const payload of substitutions(body)) substitute(payload)
        current += body.replace(DOUBLE_QUOTED_ESCAPE, '$1')
      } else {
        current += body
      }
      started = true
      quoted = true
      index = end
      continue
    }
    if (char === '$' && line[index + 1] === '(') {
      const end = matchingParen(line, index + 1)
      substitute(line.slice(index + 2, end))
      index = end
      started = true
      continue
    }
    if (char === '`') {
      const end = closingQuote(line, index)
      substitute(line.slice(index + 1, end))
      index = end
      started = true
      continue
    }
    if (char === '(' || char === ')') {
      // A subshell runs in a child shell; both edges stay visible so a `cd`
      // inside it does not move the commands after it.
      push()
      tokens.push({ text: char, quoted: false })
      continue
    }
    if (char === ' ' || char === '\t') {
      push()
      continue
    }
    if (char === '&' && line[index + 1] === '>') {
      // `&>` and `&>>` send both output streams to a file; this `&` belongs
      // to the redirection and does not end the command.
      push()
      const appending = line[index + 2] === '>'
      tokens.push({ text: appending ? '>>' : '>', quoted: false })
      index += appending ? 2 : 1
      continue
    }
    if (char === '\n' || char === ';' || char === '&' || char === '|') {
      push()
      const pair = line.slice(index, index + 2)
      if (pair === '&&' || pair === '||') {
        tokens.push({ text: pair, quoted: false })
        index += 1
      } else {
        tokens.push({ text: char, quoted: false })
      }
      continue
    }
    if (char === '>' || char === '<') {
      const appending = char === '>' && line[index + 1] === '>'
      // `2>` and `1>` attach their descriptor to the operator, not to a word.
      if (/^\d$/.test(current) && !quoted) {
        current = ''
        started = false
      }
      push()
      let last = appending ? index + 1 : index
      if (line[last + 1] === '&') {
        // `2>&1`, `>&2`, and `<&-` duplicate or close a descriptor and name no file.
        const descriptor = DESCRIPTOR.exec(line.slice(last + 2))
        if (descriptor !== null) {
          index = last + 1 + descriptor[0].length
          continue
        }
        // `>& file` sends both output streams to the file.
        last += 1
      } else if (line.slice(index, index + 2) === '>|') {
        // `>|` truncates even where the shell would refuse to overwrite.
        last += 1
      }
      tokens.push({ text: appending ? '>>' : char, quoted: false })
      index = last
      continue
    }
    current += char
    started = true
  }
  push()
  return { tokens, nested }
}

/**
 * Index of the character closing the quote or backtick at `open`, or the line
 * end when unterminated. Inside double quotes a backslash escapes the next
 * character, so `\"` does not close them.
 * @param line - the line being scanned.
 * @param open - index of the opening `'`, `"`, or backtick.
 * @returns index of the closing character.
 */
function closingQuote(line: string, open: number): number {
  const quote = line[open]
  for (let index = open + 1; index < line.length; index += 1) {
    if (line[index] === quote) return index
    if (quote === '"' && line[index] === '\\') index += 1
  }
  return line.length
}

/**
 * Index of the `)` closing the `(` at `open`, or the line end when unbalanced.
 * A parenthesis inside quotes does not count.
 * @param line - the line being scanned.
 * @param open - index of the opening parenthesis.
 * @returns index of the matching parenthesis.
 */
function matchingParen(line: string, open: number): number {
  let depth = 0
  for (let index = open; index < line.length; index += 1) {
    const char = line[index]
    if (char === "'" || char === '"') index = closingQuote(line, index)
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return line.length
}

/**
 * Every `$( )` and backtick payload inside a double-quoted body.
 * @param body - the quoted text.
 * @returns the nested command lines, outermost first.
 */
function substitutions(body: string): string[] {
  const found: string[] = []
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '$' && body[index + 1] === '(') {
      const end = matchingParen(body, index + 1)
      found.push(body.slice(index + 2, end))
      index = end
    } else if (body[index] === '`') {
      const end = closingQuote(body, index)
      found.push(body.slice(index + 1, end))
      index = end
    }
  }
  return found
}

/**
 * Every chain in the given directory sets once, in first-seen order.
 * @param sets - directory sets to combine.
 * @returns the combined set without repeated chains.
 */
function union(...sets: Directories[]): Directories {
  const kept = new Map<string, Chain>()
  for (const set of sets) {
    for (const chain of set) kept.set(chain.join('\0'), chain)
  }
  return [...kept.values()]
}

/**
 * The directory a `cd` names, when the line spells it out. `cd` alone, `cd -`,
 * a `~` path, and a word holding an expansion or a substitution depend on the
 * environment, so they name none.
 * @param args - the words after `cd`.
 * @returns the target as written, or `undefined` when it is not literal.
 */
function cdTarget(args: readonly string[]): string | undefined {
  const target = args.find(word => !word.startsWith('-'))
  if (target === undefined || target === '' || target.startsWith('~') || /[$`]/.test(target)) return undefined
  return target
}

/**
 * Parse one command line into the simple commands it would run, flattening
 * pipelines, chains, subshells, compound commands, substitutions, and `sh -c`
 * and `eval` payloads.
 * @param line - the raw command line.
 * @returns every simple command the line would execute, in written order.
 */
export function parseCommandLine(line: string): SimpleCommand[] {
  return parseLine(line, START)
}

/**
 * Parse a command line whose first command may run in any of `start`.
 * @param line - the raw command line.
 * @param start - where the line begins, relative to the directory the whole
 *   classified line starts in.
 * @returns every simple command the line would execute, in written order.
 */
function parseLine(line: string, start: Directories): SimpleCommand[] {
  const { tokens, nested } = tokenize(line)
  const drafts: { readonly command: SimpleCommand; readonly piped: boolean }[] = []
  const payloads: { readonly line: string; readonly start: Directories }[] = []
  let argv: string[] = []
  let redirections: Redirection[] = []
  let pending: Redirection['operator'] | undefined
  let negated = false
  let previous = ''
  // Where the next command may run, and where a later one may run once the
  // current `&&` chain breaks, since a `cd` inside that chain may have failed.
  let here = start
  let fallback: Directories | undefined
  const subshells: { readonly here: Directories; readonly fallback: Directories | undefined }[] = []

  // Move past a `cd` that runs in this shell. Only `&&` guarantees the `cd`
  // succeeded before the next command runs, and not after a `!`, which
  // inverts its status.
  const follow = (args: readonly string[], operator: string): void => {
    const target = cdTarget(args)
    if (target === undefined) return
    const moved = union(here.map(chain => target.startsWith('/') ? [target] : [...chain, target]))
    const either = union(here, moved)
    if (either.length > MAX_DIRECTORIES) return
    fallback = fallback === undefined ? either : union(fallback, either)
    here = operator === '&&' && !negated ? moved : either
  }

  const flush = (operator: string): void => {
    const [program, ...rest] = argv
    // A redirection with no command word still opens its target, as the
    // shell's null command does, so it is kept under an empty program.
    if (program !== undefined || redirections.length > 0) {
      const where = here.length === 1 && here.every(chain => chain.length === 0) ? {} : { directories: here }
      drafts.push({ command: { argv: [program ?? '', ...rest], redirections, ...where }, piped: operator === '|' })
      // A pipeline stage and a background job run in a child shell, so their `cd` moves nothing after them.
      if (program === 'cd' && previous !== '|' && operator !== '|' && operator !== '&') follow(rest, operator)
    }
    if (CHAIN_BREAKS.has(operator) && fallback !== undefined) {
      here = union(fallback, here)
      fallback = undefined
    }
    argv = []
    redirections = []
    negated = false
    previous = operator
  }

  for (const [index, token] of tokens.entries()) {
    for (const payload of nested) {
      if (payload.token === index) payloads.push({ line: payload.line, start: here })
    }
    if (!token.quoted && (token.text === '(' || token.text === ')')) {
      flush(token.text)
      if (token.text === '(') {
        subshells.push({ here, fallback })
        fallback = undefined
        continue
      }
      // A `)` that closes no subshell, such as a `case` pattern's, changes nothing.
      const outer = subshells.pop()
      if (outer !== undefined) ({ here, fallback } = outer)
      continue
    }
    if (!token.quoted && OPERATORS.has(token.text)) {
      flush(token.text)
      continue
    }
    if (!token.quoted && (token.text === '>' || token.text === '>>' || token.text === '<')) {
      pending = token.text
      continue
    }
    if (pending !== undefined) {
      redirections.push({ operator: pending, target: token.text })
      pending = undefined
      continue
    }
    // `NAME=value` words before the program set its environment.
    if (argv.length === 0 && ASSIGNMENT.test(token.text)) continue
    if (argv.length === 0 && !token.quoted && RESERVED.has(token.text)) {
      if (token.text === '!') negated = true
      continue
    }
    argv.push(token.text)
  }
  flush('')

  // Resolve each pipe's downstream program now that the next command is known.
  const resolved = drafts.map(({ command, piped }, index): SimpleCommand => {
    const next = drafts[index + 1]
    return piped && next !== undefined ? { ...command, pipesInto: effectiveProgram(next.command.argv) } : command
  })

  const expanded: SimpleCommand[] = []
  for (const command of resolved) expanded.push(...withRunCommands(command))
  for (const payload of payloads) expanded.push(...parseLine(payload.line, payload.start))
  return expanded
}

/**
 * One command followed by every command it runs in turn: a `sh -c "…"` or
 * `eval` payload, and the command a wrapper program such as `sudo` or `env`
 * runs. The outer command stays in the list, so a rule naming the shell or the
 * wrapper itself still sees it; the wrapped command keeps its pipe edge and
 * directories, leaves the redirections to the outer command, and under `xargs`
 * is marked as taking more arguments from its input.
 * @param command - a parsed simple command.
 * @returns the command and the commands it runs, outermost first.
 */
function withRunCommands(command: SimpleCommand): SimpleCommand[] {
  const found: SimpleCommand[] = [command]
  const start = command.directories ?? START
  const program = basename(command.argv[0])
  if (SHELLS.has(program)) {
    const flag = command.argv.findIndex(word => isDashC(word))
    const payload = flag === -1 ? undefined : command.argv[flag + 1]
    if (payload !== undefined) found.push(...parseLine(payload, start))
  }
  // `eval` joins its arguments into one line and runs it.
  if (program === 'eval') found.push(...parseLine(command.argv.slice(1).join(' '), start))
  const inner = wrappedCommand(command.argv)
  if (inner === undefined) return found
  if ('line' in inner) {
    found.push(...parseLine(inner.line, start))
    return found
  }
  found.push(...withRunCommands({
    argv: inner.argv,
    redirections: [],
    ...command.pipesInto === undefined ? {} : { pipesInto: command.pipesInto },
    ...command.directories === undefined ? {} : { directories: command.directories },
    ...command.argumentsFromInput === true || program === 'xargs' ? { argumentsFromInput: true as const } : {},
  }))
  return found
}

/**
 * Last path segment of a program word, so `/usr/bin/rm` matches `rm`.
 * @param program - the program word as written.
 * @returns the bare program name.
 */
export function basename(program: string): string {
  const cut = program.lastIndexOf('/')
  return cut === -1 ? program : program.slice(cut + 1)
}
