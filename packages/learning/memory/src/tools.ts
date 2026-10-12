/** Agent-facing learned memory over the same store `/memory` lists and curates. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryEntryId } from './types.ts'
import { visibleTags, workspaceTag } from './workspace.ts'

/** Required services for the memory tool. */
export const inject = ['tools', 'memory']

const KINDS = ['fact', 'shortcut', 'preference'] as const

/**
 * Register the model-facing `memory` tool.
 * @param ctx Agent-scoped tool registration context.
 */
export function apply(ctx: Context): void {
  const store = ctx.memory
  ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Long-term memory across sessions. `remember` stores a durable fact, shortcut, or preference, or a lesson '
      + '(a root cause found, an approach that failed and why, a corrected assumption) the user would want later work to know; '
      + '`search` finds stored entries; `forget` deletes one by id. Entries related to the current work appear in <retrieved_memory>; '
      + 'use one only when its situation matches. Write each entry so it names its situation (the file, command, or component). '
      + 'Never remember plans or progress reports.',
    parameters: {
      action: { type: 'string', required: true, enum: ['remember', 'search', 'forget'], description: 'The operation.' },
      text: { type: 'string', description: 'remember: the knowledge to store, one or two sentences.' },
      kind: { type: 'string', enum: [...KINDS], description: 'remember: fact (default), shortcut, or preference.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'remember: short lowercase topic tags.' },
      query: { type: 'string', description: 'search: words matched against entry text and tags, best match first; omit to list everything.' },
      id: { type: 'string', description: 'forget: the entry id.' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        switch (args.action) {
          case 'remember':
            return [{ type: 'text', text: `Remembered as ${(value as { id: string }).id}.` }]
          case 'search': {
            const hits = value as { id: string; kind: string; text: string }[]
            if (hits.length === 0) return [{ type: 'text', text: 'No matching memory.' }]
            return [{ type: 'text', text: hits.map(hit => `${hit.id} (${hit.kind}): ${hit.text}`).join('\n') }]
          }
          case 'forget':
            return [{ type: 'text', text: (value as { deleted: boolean }).deleted ? 'Forgotten.' : 'No such entry.' }]
          default:
            return [{ type: 'text', text: JSON.stringify(value) }]
        }
      },
    },
    async execute(args, exec) {
      switch (args.action) {
        case 'remember': {
          if (args.text === undefined || args.text.trim().length === 0) throw new Error('remember requires `text`')
          const cwd = exec.agent?.session.header.cwd
          const entry = await store.add(
            { text: args.text, kind: args.kind ?? 'fact', tags: [...args.tags ?? [], ...cwd === undefined ? [] : [workspaceTag(cwd)]] },
            'approved',
            exec.agent?.session.id,
          )
          return { id: entry.id }
        }
        case 'search': {
          const hits = store.search(args.query ?? '')
          const usedAt = new Date().toISOString()
          for (const hit of hits) await store.touch(hit.id, { lastUsedAt: usedAt })
          return hits.map(entry => ({ id: entry.id, kind: entry.kind, tags: visibleTags(entry.tags), text: entry.text }))
        }
        case 'forget': {
          if (args.id === undefined) throw new Error('forget requires `id`')
          return { deleted: await store.forget(brandString<MemoryEntryId>(args.id)) }
        }
        default:
          throw new Error(`unknown action ${String(args.action)}`)
      }
    },
  }))
}
