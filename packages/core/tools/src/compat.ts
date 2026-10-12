/**
 * Compatibility transforms for models with weak native function calling. Both
 * are pure: {@link coerceArguments} repairs model-supplied argument values
 * against a tool's parameter schema before validation, and
 * {@link flattenNullableParameters} simplifies the model-visible parameter
 * schema without changing what the executor accepts.
 * @module
 */

import type { JsonSchemaNode } from './json-schema.ts'
import { isPlainJsonRecord } from './json-schema.ts'

/**
 * Whether a schema node admits `null` directly or through a `oneOf` branch.
 * @param node - the parameter schema node.
 * @returns true when `null` validates against the node.
 */
function admitsNull(node: JsonSchemaNode): boolean {
  if (node.type === 'null') return true
  if (node.oneOf !== undefined) return node.oneOf.some(admitsNull)
  return node.type === undefined && node.enum === undefined && node.const === undefined
}

/** Spellings accepted for a `true` boolean argument. */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on'])

/** Spellings accepted for a `false` boolean argument. */
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off'])

/**
 * Parse a string exactly as the declared scalar type, or return `undefined`
 * when the text is not an exact spelling of such a value.
 * @param type - the declared scalar type.
 * @param text - the model-supplied string.
 * @returns the parsed scalar, or `undefined` when no exact parse exists.
 */
function parseScalar(type: 'boolean' | 'number' | 'integer', text: string): number | boolean | undefined {
  switch (type) {
    case 'boolean': {
      // Z.ai's own GLM client accepts this wider spelling set per tool
      // (`semanticBoolean` in ZCode's bash contract), so a model that answers
      // `yes` or `1` for a flag is understood rather than rejected.
      const flag = text.trim().toLowerCase()
      if (TRUE_WORDS.has(flag)) return true
      if (FALSE_WORDS.has(flag)) return false
      return undefined
    }
    case 'number':
    case 'integer': {
      const trimmed = text.trim()
      if (trimmed === '' || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) return undefined
      const value = Number(trimmed)
      if (!Number.isFinite(value)) return undefined
      if (type === 'integer' && !Number.isInteger(value)) return undefined
      return value
    }
  }
}

/**
 * Coerce one value against its schema node, recursing into declared object
 * properties and array items.
 * @param node - the schema node for the value.
 * @param value - the model-supplied value.
 * @returns the coerced value, or the original when no exact coercion applies.
 */
function coerceValue(node: JsonSchemaNode, value: unknown): unknown {
  if (node.oneOf !== undefined) return value
  if (typeof value === 'string') {
    switch (node.type) {
      case 'boolean':
      case 'number':
      case 'integer': {
        const parsed = parseScalar(node.type, value)
        return parsed === undefined ? value : parsed
      }
      case 'object':
      case 'array': {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          // Not JSON text: leave the string for validation to reject.
          return value
        }
        const expectsArray = node.type === 'array'
        if (expectsArray ? Array.isArray(parsed) : isPlainJsonRecord(parsed)) return coerceValue(node, parsed)
        return value
      }
      default:
        return value
    }
  }
  if (Array.isArray(value)) {
    const items = node.items
    return items === undefined ? value : value.map(item => coerceValue(items, item))
  }
  if (isPlainJsonRecord(value) && node.properties !== undefined) {
    return coerceObject(node, value)
  }
  return value
}

/**
 * Coerce the declared properties of one object value. `null` for an optional
 * property whose schema does not admit `null` is dropped, matching the model's
 * usual intent of "not set".
 * @param node - the object schema node with `properties`.
 * @param value - the object value.
 * @returns a new object with coerced declared properties; undeclared keys pass through.
 */
function coerceObject(node: JsonSchemaNode, value: Record<string, unknown>): Record<string, unknown> {
  const properties = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const result: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const property = properties[key]
    if (property === undefined) {
      result[key] = raw
      continue
    }
    if (raw === null && !required.has(key) && !admitsNull(property)) continue
    result[key] = coerceValue(property, raw)
  }
  return result
}

/**
 * Repair model-supplied arguments against a tool's parameter schema: exact
 * numeric, integer, and boolean spellings become their scalar types, JSON text
 * for an object or array parameter is parsed, and `null` for an optional
 * non-nullable parameter is dropped. Anything that does not coerce exactly is
 * returned unchanged for validation to report.
 * @param schema - the tool's object-rooted parameter schema.
 * @param args - the parsed model arguments.
 * @returns the coerced arguments, or `args` itself when it is not an object.
 */
export function coerceArguments(schema: JsonSchemaNode, args: unknown): unknown {
  if (!isPlainJsonRecord(args)) return args
  return coerceObject(schema, args)
}

/**
 * Whether a node is `oneOf` exactly one non-null branch and one `null` branch.
 * @param node - the schema node.
 * @returns the non-null branch when the pattern matches, otherwise `undefined`.
 */
function nullableBranch(node: JsonSchemaNode): JsonSchemaNode | undefined {
  if (node.oneOf === undefined || node.oneOf.length !== 2) return undefined
  const [first, second] = node.oneOf as [JsonSchemaNode, JsonSchemaNode]
  if (first.type === 'null' && second.type !== 'null') return second
  if (second.type === 'null' && first.type !== 'null') return first
  return undefined
}

/**
 * Project a parameter schema for models whose function-call parsers mishandle
 * `oneOf`: every `oneOf: [X, {type: 'null'}]` node becomes `X` with the
 * original annotations, recursively. Validation keeps the original schema, so
 * `null` remains accepted at execution.
 * @param schema - the object-rooted parameter schema.
 * @returns a new schema with nullable unions flattened.
 */
export function flattenNullableParameters(schema: JsonSchemaNode): JsonSchemaNode {
  const branch = nullableBranch(schema)
  const base: JsonSchemaNode = branch === undefined ? { ...schema } : { ...flattenNullableParameters(branch), ...annotationsOf(schema) }
  if (base.properties !== undefined) {
    base.properties = Object.fromEntries(
      Object.entries(base.properties).map(([key, node]) => [key, flattenNullableParameters(node)]),
    )
  }
  if (base.items !== undefined) base.items = flattenNullableParameters(base.items)
  if (base.oneOf !== undefined && branch === undefined) base.oneOf = base.oneOf.map(flattenNullableParameters)
  return base
}

/**
 * The annotation keywords of a node, used to carry a nullable wrapper's
 * description onto its flattened branch.
 * @param node - the wrapper node.
 * @returns the subset of annotation fields present on the node.
 */
function annotationsOf(node: JsonSchemaNode): Partial<JsonSchemaNode> {
  const out: Partial<JsonSchemaNode> = {}
  if (node.description !== undefined) out.description = node.description
  if (node.title !== undefined) out.title = node.title
  if (node.default !== undefined) out.default = node.default
  if (node.examples !== undefined) out.examples = node.examples
  return out
}
