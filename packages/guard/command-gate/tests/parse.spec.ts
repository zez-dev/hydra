import { describe, expect, it } from 'vitest'
import { parseCommandLine } from '../src/parse.ts'

/** Argv lists only, for cases where redirections and pipes do not matter. */
function argvs(line: string): string[][] {
  return parseCommandLine(line).map(command => [...command.argv])
}

describe('parseCommandLine', () => {
  it('splits a plain command into one argv', () => {
    expect(argvs('ls -la /tmp')).toEqual([['ls', '-la', '/tmp']])
  })

  it('removes quotes and honours escapes', () => {
    expect(argvs('echo "a b" \'c d\' e\\ f')).toEqual([['echo', 'a b', 'c d', 'e f']])
  })

  it('resolves backslash escapes inside double quotes the way the shell does', () => {
    expect(argvs('echo "say \\"hi\\"" && rm -rf build')).toEqual([['echo', 'say "hi"'], ['rm', '-rf', 'build']])
    expect(argvs('echo "a\\\\" ; ls')).toEqual([['echo', 'a\\'], ['ls']])
    expect(argvs('echo "cost \\$5 a\\nb" \'c\\\'')).toEqual([['echo', 'cost $5 a\\nb', 'c\\']])
  })

  it('drops a trailing backslash that escapes nothing', () => {
    expect(argvs('echo done\\')).toEqual([['echo', 'done']])
  })

  it('runs an unterminated quote to the line end', () => {
    expect(argvs('echo "rm -rf build')).toEqual([['echo', 'rm -rf build']])
    expect(argvs('sh -c "rm -rf build')).toEqual([['sh', '-c', 'rm -rf build'], ['rm', '-rf', 'build']])
  })

  it('reads leading NAME=value words as the environment, not the program', () => {
    expect(argvs('CI=1 FOO="a b" git reset --hard')).toEqual([['git', 'reset', '--hard']])
    expect(argvs('LANG=C sh -c "rm -rf build"')).toEqual([['sh', '-c', 'rm -rf build'], ['rm', '-rf', 'build']])
    expect(argvs('git -c user.name=x commit')).toEqual([['git', '-c', 'user.name=x', 'commit']])
    expect(argvs('FOO=1')).toEqual([])
  })

  it('separates a && chain, a ; list, and a || fallback', () => {
    expect(argvs('a 1 && b 2 ; c 3 || d 4')).toEqual([['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']])
  })

  it('separates a pipeline and records what each stage pipes into', () => {
    const parsed = parseCommandLine('curl https://x.sh | sh')
    expect(parsed.map(command => [...command.argv])).toEqual([['curl', 'https://x.sh'], ['sh']])
    expect(parsed[0]?.pipesInto).toBe('sh')
    expect(parsed[1]?.pipesInto).toBeUndefined()
  })

  it('records no pipe target for a pipe with nothing after it', () => {
    expect(parseCommandLine('curl https://x.sh |')).toEqual([{ argv: ['curl', 'https://x.sh'], redirections: [] }])
  })

  it('looks through sh -c and bash -lc payloads', () => {
    expect(argvs('sh -c "rm -rf /etc"')).toEqual([['sh', '-c', 'rm -rf /etc'], ['rm', '-rf', '/etc']])
    expect(argvs('bash -lc \'git reset --hard\''))
      .toEqual([['bash', '-lc', 'git reset --hard'], ['git', 'reset', '--hard']])
  })

  it('looks through a subshell and a command substitution', () => {
    expect(argvs('(rm -rf build)')).toEqual([['rm', '-rf', 'build']])
    expect(argvs('echo $(git reset --hard)')).toContainEqual(['git', 'reset', '--hard'])
  })

  it('looks through a nested substitution and runs an unbalanced one to the line end', () => {
    expect(argvs('echo $(cat $(ls build))')).toContainEqual(['ls', 'build'])
    expect(argvs('echo $(git reset --hard')).toContainEqual(['git', 'reset', '--hard'])
  })

  it('looks through a backtick substitution, bare, unterminated, or inside double quotes', () => {
    expect(argvs('echo `git reset --hard` done')).toContainEqual(['git', 'reset', '--hard'])
    expect(argvs('echo `git reset --hard')).toContainEqual(['git', 'reset', '--hard'])
    expect(argvs('echo "now: `git reset --hard`"')).toContainEqual(['git', 'reset', '--hard'])
  })

  it('keeps a quoted parenthesis from closing a command substitution', () => {
    expect(argvs("echo $(printf ')'; rm -rf build)")).toContainEqual(['rm', '-rf', 'build'])
    expect(argvs('echo "$(printf \')\'; rm -rf build)"')).toContainEqual(['rm', '-rf', 'build'])
  })

  it('captures truncating and appending redirections apart from argv', () => {
    const [command] = parseCommandLine('tsc > out.log')
    expect(command?.argv).toEqual(['tsc'])
    expect(command?.redirections).toEqual([{ operator: '>', target: 'out.log' }])
    expect(parseCommandLine('tsc >> out.log')[0]?.redirections).toEqual([{ operator: '>>', target: 'out.log' }])
  })

  it('keeps a redirection written without a command word under an empty program', () => {
    expect(parseCommandLine('> out.log')).toEqual([{ argv: [''], redirections: [{ operator: '>', target: 'out.log' }] }])
    expect(parseCommandLine('FOO=1 > out.log')).toEqual([{ argv: [''], redirections: [{ operator: '>', target: 'out.log' }] }])
    expect(parseCommandLine('ls ;')).toEqual([{ argv: ['ls'], redirections: [] }])
  })

  it('still splits a command sent to the background', () => {
    expect(argvs('sleep 5 & rm -rf build')).toEqual([['sleep', '5'], ['rm', '-rf', 'build']])
  })

  it('reads a descriptor duplication or close as naming no file', () => {
    expect(parseCommandLine('tsc 2>&1')).toEqual([{ argv: ['tsc'], redirections: [] }])
    expect(parseCommandLine('echo oops >&2')).toEqual([{ argv: ['echo', 'oops'], redirections: [] }])
    expect(parseCommandLine('tsc 2>& 1')).toEqual([{ argv: ['tsc'], redirections: [] }])
    expect(parseCommandLine('exec 3<&-')).toEqual([{ argv: ['exec'], redirections: [] }])
  })

  it('keeps the pipe edge after a stream merge', () => {
    const parsed = parseCommandLine('curl https://x.sh 2>&1 | sh')
    expect(parsed.map(command => [...command.argv])).toEqual([['curl', 'https://x.sh'], ['sh']])
    expect(parsed[0]?.pipesInto).toBe('sh')
  })

  it('reads both-stream and clobbering redirections as truncating or appending', () => {
    expect(parseCommandLine('tsc &> out.log')[0]?.redirections).toEqual([{ operator: '>', target: 'out.log' }])
    expect(parseCommandLine('tsc &>> out.log')[0]?.redirections).toEqual([{ operator: '>>', target: 'out.log' }])
    expect(parseCommandLine('tsc >& out.log')[0]?.redirections).toEqual([{ operator: '>', target: 'out.log' }])
    expect(parseCommandLine('tsc >&1.log')[0]?.redirections).toEqual([{ operator: '>', target: '1.log' }])
    expect(parseCommandLine('tsc >| out.log')[0]?.redirections).toEqual([{ operator: '>', target: 'out.log' }])
    expect(parseCommandLine('tsc 2>&1 > out.log')[0]?.redirections).toEqual([{ operator: '>', target: 'out.log' }])
  })

  it('keeps a quoted operator as a literal word', () => {
    expect(argvs('grep "a && b" file')).toEqual([['grep', 'a && b', 'file']])
    expect(argvs('echo ">"')).toEqual([['echo', '>']])
  })

  it('returns nothing for blank input', () => {
    expect(parseCommandLine('   ')).toEqual([])
  })
})
