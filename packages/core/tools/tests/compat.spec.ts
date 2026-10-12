import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { coerceArguments, defineTool, flattenNullableParameters, type Config, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'

const signal = new AbortController().signal

async function setup(config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, config)
  return ctx
}

const readTool = defineTool({
  name: 'read',
  description: 'read a slice',
  parameters: {
    path: { type: 'string', required: true },
    offset: { type: 'integer' },
    ratio: { type: 'number' },
    follow: { type: 'boolean' },
    lines: { type: 'array', items: { type: 'integer' } },
    note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  execute: async args => args as never,
})

describe('coerceArguments', () => {
  const schema = readTool.parameters

  it('accepts the wider boolean spellings Z.ai\'s own GLM client takes', () => {
    for (const yes of ['true', 'TRUE', ' yes ', 'y', 'on', '1']) {
      expect(coerceArguments(schema, { path: 'a', follow: yes })).toEqual({ path: 'a', follow: true })
    }
    for (const no of ['false', 'No', 'n', 'off', '0']) {
      expect(coerceArguments(schema, { path: 'a', follow: no })).toEqual({ path: 'a', follow: false })
    }
    expect(coerceArguments(schema, { path: 'a', follow: 'maybe' })).toEqual({ path: 'a', follow: 'maybe' })
  })

  it('parses exact numeric, integer, and boolean strings into their declared scalar types', () => {
    expect(coerceArguments(schema, { path: 'a', offset: '10', ratio: '0.5', follow: 'true' }))
      .toEqual({ path: 'a', offset: 10, ratio: 0.5, follow: true })
  })

  it('leaves strings that do not parse exactly untouched', () => {
    expect(coerceArguments(schema, { path: 'a', offset: '10abc', ratio: '', follow: 'perhaps' }))
      .toEqual({ path: 'a', offset: '10abc', ratio: '', follow: 'perhaps' })
  })

  it('does not turn a non-integer numeric string into an integer parameter', () => {
    expect(coerceArguments(schema, { path: 'a', offset: '1.5' })).toEqual({ path: 'a', offset: '1.5' })
  })

  it('parses a JSON string for an array or object parameter', () => {
    expect(coerceArguments(schema, { path: 'a', lines: '[1, 2]' })).toEqual({ path: 'a', lines: [1, 2] })
  })

  it('drops null for an optional parameter whose schema does not admit null', () => {
    expect(coerceArguments(schema, { path: 'a', offset: null })).toEqual({ path: 'a' })
  })

  it('keeps null for a required parameter and for a nullable parameter', () => {
    expect(coerceArguments(schema, { path: null, note: null })).toEqual({ path: null, note: null })
  })

  it('coerces inside nested objects and array items', () => {
    const nested = defineTool({
      name: 'n',
      description: 'n',
      parameters: {
        box: { type: 'object', additionalProperties: false, properties: { size: { type: 'integer' } } },
        sizes: { type: 'array', items: { type: 'integer' } },
      },
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async () => null,
    }).parameters
    expect(coerceArguments(nested, { box: { size: '3' }, sizes: ['1', '2'] }))
      .toEqual({ box: { size: 3 }, sizes: [1, 2] })
  })

  it('returns non-object arguments and undeclared properties unchanged', () => {
    expect(coerceArguments(schema, 'garbage')).toBe('garbage')
    expect(coerceArguments(schema, { path: 'a', extra: '1' })).toEqual({ path: 'a', extra: '1' })
  })
})

describe('coerceArguments edge cases', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { enum: ['fast', 'slow'] },
      marker: { const: 'x' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      options: { type: 'object', properties: { depth: { type: 'integer' } } },
      list: { type: 'array', items: { type: 'integer' } },
      loose: { type: 'array' },
    },
  } satisfies JsonSchemaNode

  it('drops null for an optional enum or const parameter, which never admits null', () => {
    expect(coerceArguments(schema, { mode: null, marker: null })).toEqual({})
  })

  it('leaves a numeric string that overflows to infinity untouched', () => {
    expect(coerceArguments(schema, { ratio: '1e999' })).toEqual({ ratio: '1e999' })
  })

  it('parses JSON text for an object parameter, and leaves text that is not JSON or has the wrong shape', () => {
    expect(coerceArguments(schema, { options: '{"depth":"2"}' })).toEqual({ options: { depth: 2 } })
    expect(coerceArguments(schema, { list: 'not json', options: '[1]' })).toEqual({ list: 'not json', options: '[1]' })
  })

  it('passes array items through when the array declares no item schema', () => {
    expect(coerceArguments(schema, { loose: ['1', 2] })).toEqual({ loose: ['1', 2] })
  })

  it('passes every property through a schema that declares none', () => {
    expect(coerceArguments({ type: 'object' }, { count: '1', other: null })).toEqual({ count: '1', other: null })
  })
})

describe('argumentCoercion config', () => {
  it('rejects a stringly-typed integer under the default strict policy', async () => {
    const ctx = await setup()
    ctx.tools.register(readTool)
    const result = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'read', arguments: { path: 'a', offset: '10' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('invalid arguments')
  })

  it('coerces before validation and dispatch under lenient policy', async () => {
    const ctx = await setup({ argumentCoercion: 'lenient' })
    ctx.tools.register(readTool)
    let seen: unknown
    ctx.on('tools/pre-execute', (exec, next) => { seen = exec.arguments; return next() })
    const result = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'read', arguments: { path: 'a', offset: '10', note: null } })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ path: 'a', offset: 10, note: null })
    expect(seen).toEqual({ path: 'a', offset: 10, note: null })
  })
})

describe('flattenNullableParameters', () => {
  it('replaces a two-branch oneOf with a null branch by the other branch, keeping annotations', () => {
    expect(flattenNullableParameters({
      type: 'object',
      properties: {
        text: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'd' },
        range: { oneOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
        keep: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    })).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'd' },
        range: { type: 'array', items: { type: 'integer' } },
        keep: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    })
  })

  it('flattens a union that lists null first and carries its title, default, and examples', () => {
    expect(flattenNullableParameters({
      type: 'object',
      properties: {
        limit: { oneOf: [{ type: 'null' }, { type: 'integer' }], title: 'Limit', default: 10, examples: [5] },
        both: { oneOf: [{ type: 'null' }, { type: 'null' }] },
      },
    })).toEqual({
      type: 'object',
      properties: {
        limit: { type: 'integer', title: 'Limit', default: 10, examples: [5] },
        both: { oneOf: [{ type: 'null' }, { type: 'null' }] },
      },
    })
  })
})

describe('nullableParameters config', () => {
  it('keeps oneOf in model-visible schemas by default', async () => {
    const ctx = await setup()
    ctx.tools.register(readTool)
    const schema = ctx.tools.schemas()[0]!.parameters as { properties: Record<string, unknown> }
    expect(schema.properties.note).toEqual({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  })

  it('flattens nullable parameters in model-visible schemas and prompt assembly under flat', async () => {
    const ctx = await setup({ nullableParameters: 'flat' })
    ctx.tools.register(readTool)
    const schema = ctx.tools.schemas()[0]!.parameters as { properties: Record<string, unknown> }
    expect(schema.properties.note).toEqual({ type: 'string' })
    const assembly = await ctx.systemPrompt.assemble()
    const assembled = assembly.tools[0]!.parameters as { properties: Record<string, unknown> }
    expect(assembled.properties.note).toEqual({ type: 'string' })
    // Validation still accepts null: the flattening is presentation-only.
    const result = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'read', arguments: { path: 'a', note: null } })
    expect(result.isError).toBe(false)
  })
})
