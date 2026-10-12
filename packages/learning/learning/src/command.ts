/**
 * The `/learn` command: review memory candidates and promote one to a skill.
 * @module
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LearningSkillView } from './types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { MemoryEntry, MemoryEntryId, MemoryStore, MemorySuggestionId } from '@deepseek-ai/dsh-memory'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { parseLearnFromInput, type LearnFromRequest } from './ingest.ts'

/** Accepted skill names: lowercase letters, digits, and single hyphens. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const USAGE = 'Usage: /learn [approve <id> | reject <id> | skill <id> <name> | accept <suggestion> [name] | dismiss <suggestion> | from <path> [--tags a,b] [--as-skills]'
  + ' | drafts | publish <draft> [as <name>] | discard <draft> | consolidate [--all]]; /digest <path> [--tags a,b] lets the model sort a folder into skill drafts and entries'

/** The folders `/learn` writes skills to. */
export interface LearningRoots {
  /** Live skills, `<name>/SKILL.md`, loaded by the skill loader. */
  readonly skills: string
  /** Skill drafts from `/digest`, `<name>/SKILL.md`, invisible to the skill loader until published. */
  readonly drafts: string
}

/**
 * Render candidates for review.
 * @param entries - candidate entries.
 * @returns one line per candidate, or a note when none is pending.
 */
function renderCandidates(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return 'No memory candidates awaiting review.'
  return [
    `${entries.length} candidate(s):`,
    ...entries.map(entry => `  ${entry.id} [${entry.kind}${entry.tags.length > 0 ? `; ${entry.tags.join(', ')}` : ''}] ${entry.text}`),
    USAGE,
  ].join('\n')
}

/**
 * Render a SKILL.md document for one entry.
 * @param name - the skill name.
 * @param entry - the promoted entry.
 * @returns the file contents.
 */
export function renderSkillFile(name: string, entry: MemoryEntry): string {
  const description = entry.text.length <= 200 ? entry.text : `${entry.text.slice(0, 197)}...`
  const whenToUse = entry.tags.length === 0 ? undefined : `When working with ${entry.tags.join(', ')}.`
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...whenToUse === undefined ? [] : [`whenToUse: ${JSON.stringify(whenToUse)}`],
    '---',
    '',
    `# ${name}`,
    '',
    entry.text,
    '',
  ].join('\n')
}

/**
 * Render a SKILL.md document that bundles several entries.
 * @param name - the skill name.
 * @param entries - the promoted entries, in order.
 * @returns the file contents.
 */
export function renderSkillBundle(name: string, entries: readonly MemoryEntry[]): string {
  const first = entries[0]?.text ?? ''
  const description = entries.length === 1
    ? (first.length <= 200 ? first : `${first.slice(0, 197)}...`)
    : `${entries.length} related notes: ${first.length <= 120 ? first : `${first.slice(0, 117)}...`}`
  const tags = [...new Set(entries.flatMap(entry => entry.tags.filter(tag => !/^(?:source|error):/u.test(tag))))]
  const whenToUse = tags.length === 0 ? undefined : `When working with ${tags.join(', ')}.`
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...whenToUse === undefined ? [] : [`whenToUse: ${JSON.stringify(whenToUse)}`],
    '---',
    '',
    `# ${name}`,
    '',
    ...entries.map(entry => `- ${entry.text}`),
    '',
  ].join('\n')
}

/**
 * Write the skill file and register it live when a skill registry is mounted.
 * @param ctx - plugin context.
 * @param skillsRoot - directory holding `<name>/SKILL.md` bundles.
 * @param name - the skill name.
 * @param entry - the promoted entry.
 * @returns the written path.
 */
export async function promoteToSkill(ctx: Context, skillsRoot: string, name: string, entry: MemoryEntry): Promise<string> {
  const directory = join(skillsRoot, name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, renderSkillFile(name, entry), 'utf8')
  registerSkill(ctx, name, entry.text.length <= 200 ? entry.text : `${entry.text.slice(0, 197)}...`, entry.text, directory)
  return path
}

/**
 * Write one imported document as a skill under the skills root and register
 * it live when a skill registry is mounted. The document is the skill body as
 * written; only the frontmatter is the harness's own.
 * @param ctx - plugin context.
 * @param skillsRoot - directory holding `<name>/SKILL.md` bundles.
 * @param name - the skill name.
 * @param description - the one-line routing description.
 * @param body - the document text.
 * @returns the written path.
 */
export async function writeDocumentSkill(
  ctx: Context,
  skillsRoot: string,
  name: string,
  description: string,
  body: string,
): Promise<string> {
  const directory = join(skillsRoot, name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  const content = body.trimStart().startsWith('---') ? body : `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`
  await writeFile(path, content, 'utf8')
  registerSkill(ctx, name, description, body, directory)
  return path
}

/** Live registrations of skills this plugin wrote, so a rewrite or delete can drop the previous one. */
const registrations = new Map<string, () => void>()

/**
 * Register a skill live when a registry is mounted, replacing any earlier registration of the name.
 * @param ctx - plugin context.
 * @param name - the skill name.
 * @param description - the routing description.
 * @param content - the skill body.
 * @param directory - the skill directory.
 */
function registerSkill(ctx: Context, name: string, description: string, content: string, directory: string): void {
  const skills: SkillRegistry | undefined = ctx.get('skills')
  if (skills === undefined) return
  registrations.get(name)?.()
  const dispose = ctx.effect(() => skills.register({
    name,
    description,
    content,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: directory },
  }), `learning.skill.${name}`)
  registrations.set(name, () => { void dispose() })
}

/**
 * The frontmatter `description`, else the first heading, else the name of a skill file.
 * @param name - the skill name.
 * @param content - the file contents.
 * @returns a one-line description.
 */
function describeSkill(name: string, content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1)
    for (const line of lines.slice(1, end === -1 ? lines.length : end)) {
      const match = /^description:\s*(.+)$/u.exec(line)
      if (match?.[1] !== undefined) return match[1].trim().replace(/^["']|["']$/gu, '').slice(0, 200)
    }
  }
  const heading = lines.find(line => /^#+\s+\S/u.test(line))?.replace(/^#+\s+/u, '').trim()
  return heading === undefined || heading.length === 0 ? name : heading.slice(0, 200)
}

/**
 * List the skills under the skills root.
 * @param skillsRoot - directory holding `<name>/SKILL.md` bundles.
 * @returns skills sorted by name; a missing root lists nothing.
 */
export async function listSkills(skillsRoot: string): Promise<LearningSkillView[]> {
  let names: string[]
  try {
    names = (await readdir(skillsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    // No skills root yet: nothing was ever written.
    return []
  }
  const views: LearningSkillView[] = []
  for (const name of names) {
    const path = join(skillsRoot, name, 'SKILL.md')
    try {
      const content = await readFile(path, 'utf8')
      views.push({ name, description: describeSkill(name, content), path, bytes: Buffer.byteLength(content) })
    } catch {
      // A directory without a SKILL.md is not a skill.
    }
  }
  return views
}

/**
 * Read one skill file.
 * @param skillsRoot - directory holding `<name>/SKILL.md` bundles.
 * @param name - the skill name.
 * @returns the contents, or `undefined` when the skill does not exist.
 */
export async function readSkill(skillsRoot: string, name: string): Promise<string | undefined> {
  if (!SKILL_NAME.test(name)) return undefined
  try {
    return await readFile(join(skillsRoot, name, 'SKILL.md'), 'utf8')
  } catch {
    // Missing skill.
    return undefined
  }
}

/**
 * Replace one skill file and re-register it live.
 * @param ctx - plugin context.
 * @param skillsRoot - directory holding `<name>/SKILL.md` bundles.
 * @param name - the skill name.
 * @param content - the complete file contents.
 * @returns the written path.
 * @throws when the name is invalid or the content is blank.
 */
export async function writeSkill(ctx: Context, skillsRoot: string, name: string, content: string): Promise<string> {
  if (!SKILL_NAME.test(name)) throw new Error(SKILL_NAME_HELP)
  if (content.trim().length === 0) throw new Error('A skill file cannot be blank.')
  const directory = join(skillsRoot, name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, content, 'utf8')
  registerSkill(ctx, name, describeSkill(name, content), content, directory)
  return path
}

/**
 * Delete one skill directory and drop its live registration.
 * @param ctx - plugin context.
 * @param skillsRoot - directory holding `<name>/SKILL.md` bundles.
 * @param name - the skill name.
 * @returns whether a skill existed.
 */
export async function deleteSkill(ctx: Context, skillsRoot: string, name: string): Promise<boolean> {
  if (!SKILL_NAME.test(name)) return false
  const directory = join(skillsRoot, name)
  const existed = await readSkill(skillsRoot, name) !== undefined
  if (!existed) return false
  registrations.get(name)?.()
  registrations.delete(name)
  await rm(directory, { recursive: true, force: true })
  void ctx
  return true
}

/**
 * Make a draft live: move its folder into the skills root under `target`,
 * name the skill `target` in its frontmatter, and register it live.
 * @param ctx - plugin context.
 * @param roots - the drafts and live skills folders.
 * @param name - the draft.
 * @param target - the live skill's name.
 * @returns the live skill file path, or why nothing was published: an invalid name, a missing draft,
 *   or a live skill already named `target`.
 */
export async function publishDraft(
  ctx: Context,
  roots: LearningRoots,
  name: string,
  target: string,
): Promise<{ readonly path: string } | { readonly refused: string }> {
  if (!SKILL_NAME.test(name) || !SKILL_NAME.test(target)) return { refused: SKILL_NAME_HELP }
  const draft = await readSkill(roots.drafts, name)
  if (draft === undefined) return { refused: `No skill draft ${name}; /learn drafts lists them.` }
  if ((await readdir(roots.skills).catch(() => [] as string[])).includes(target)) {
    return { refused: `A skill named ${target} already exists; publish under another name with \`/learn publish ${name} as <name>\`.` }
  }
  const directory = join(roots.skills, target)
  await cp(join(roots.drafts, name), directory, { recursive: true })
  await rm(join(directory, 'draft.json'), { force: true })
  const content = draft.replace(/^name: .*$/mu, `name: ${target}`)
  const path = join(directory, 'SKILL.md')
  await writeFile(path, content, 'utf8')
  await rm(join(roots.drafts, name), { recursive: true, force: true })
  registerSkill(ctx, target, describeSkill(target, content), content, directory)
  return { path }
}

/**
 * Delete a draft.
 * @param draftsRoot - the drafts folder.
 * @param name - the draft.
 * @returns whether the draft existed.
 */
export async function discardDraft(draftsRoot: string, name: string): Promise<boolean> {
  if (await readSkill(draftsRoot, name) === undefined) return false
  await rm(join(draftsRoot, name), { recursive: true, force: true })
  return true
}

/**
 * Render the drafts for `/learn drafts`.
 * @param drafts - the drafts.
 * @returns one line per draft, or a note when there is none.
 */
function renderDrafts(drafts: readonly LearningSkillView[]): string {
  if (drafts.length === 0) return 'No skill drafts. /digest <path> drafts skills from the documents it reads as procedures.'
  return [
    `${drafts.length} skill draft(s), not live until published:`,
    ...drafts.map(draft => `  ${draft.name}: ${draft.description} (${draft.path})`),
    'Read or edit a draft at its path; /learn publish <draft> [as <name>] makes it live, /learn discard <draft> deletes it.',
  ].join('\n')
}

/** The message every invalid skill name gets. */
export const SKILL_NAME_HELP = 'A skill name is required: lowercase letters, digits, and single hyphens (for example `run-one-package-tests`).'

/**
 * Promote one stored entry: validate the name, write the skill, mark the entry.
 * @param ctx - plugin context.
 * @param store - the memory store.
 * @param skillsRoot - directory that receives promoted skills.
 * @param id - the entry to promote.
 * @param name - the skill name.
 * @returns the written skill file path.
 * @throws when the entry is unknown or the name is invalid.
 */
export async function promoteEntry(ctx: Context, store: MemoryStore, skillsRoot: string, id: MemoryEntryId, name: string): Promise<string> {
  const entry = store.get(id)
  if (entry === undefined) throw new Error(`No memory entry ${String(id)}.`)
  if (!SKILL_NAME.test(name)) throw new Error(SKILL_NAME_HELP)
  const path = await promoteToSkill(ctx, skillsRoot, name, entry)
  await store.setStatus(id, 'promoted')
  return path
}

/**
 * Promote several stored entries as one skill: validate, write the bundle, mark each entry.
 * @param ctx - plugin context.
 * @param store - the memory store.
 * @param skillsRoot - directory that receives promoted skills.
 * @param ids - the entries to promote together.
 * @param name - the skill name.
 * @returns the written skill file path.
 * @throws when an entry is unknown, the list is empty, or the name is invalid.
 */
export async function promoteEntries(
  ctx: Context,
  store: MemoryStore,
  skillsRoot: string,
  ids: readonly MemoryEntryId[],
  name: string,
): Promise<string> {
  if (ids.length === 0) throw new Error('No memory entries to promote.')
  if (!SKILL_NAME.test(name)) throw new Error(SKILL_NAME_HELP)
  const entries = ids.map((id) => {
    const entry = store.get(id)
    if (entry === undefined) throw new Error(`No memory entry ${String(id)}.`)
    return entry
  })
  const directory = join(skillsRoot, name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  const contents = renderSkillBundle(name, entries)
  await writeFile(path, contents, 'utf8')
  const skills: SkillRegistry | undefined = ctx.get('skills')
  if (skills !== undefined) {
    const description = /^description: (.*)$/mu.exec(contents)?.[1]
    ctx.effect(() => skills.register({
      name,
      description: description === undefined ? name : JSON.parse(description) as string,
      content: entries.map(entry => entry.text).join('\n'),
      source: 'runtime',
      resourceBase: { kind: 'directory', path: directory },
    }), `learning.skill.${name}`)
  }
  for (const id of ids) await store.setStatus(id, 'promoted')
  return path
}

/**
 * Handle one `/learn` invocation.
 * @param ctx - plugin context.
 * @param store - the memory store.
 * @param roots - the folders receiving promoted skills and holding drafts.
 * @param invocation - the parsed command input.
 * @param importer - runs `/learn from <path>`; the plugin supplies the extraction-backed importer.
 * @param consolidator - runs `/learn consolidate`, every workspace's entries when `all` is set.
 * @returns the command result.
 */
export async function executeLearnCommand(
  ctx: Context,
  store: MemoryStore,
  roots: LearningRoots,
  invocation: CommandInvocation,
  importer: (request: LearnFromRequest) => Promise<CommandResult>,
  consolidator: (all: boolean) => Promise<CommandResult>,
): Promise<CommandResult> {
  const words = invocation.rawInput.trim().split(/\s+/u).filter(word => word.length > 0)
  if (words.length === 0 || words[0] === 'list') {
    const candidates = store.list({ status: 'candidate' })
    if (candidates.length > 0) return { kind: 'success', text: renderCandidates(candidates) }
    const learned = store.recalled().slice(-20)
    return { kind: 'success', text: learned.length === 0 ? 'Nothing learned yet. Import a folder with `/learn from <path>`.' : `Learned (${store.recalled().length} total, newest last):\n${learned.map(entry => `- [${entry.kind}] ${entry.text}`).join('\n')}` }
  }
  if (words[0] === 'from') {
    const request = parseLearnFromInput(invocation.rawInput)
    if (request === undefined) return { kind: 'error', text: USAGE }
    return importer(request)
  }
  if (words[0] === 'drafts') return { kind: 'success', text: renderDrafts(await listSkills(roots.drafts)) }
  if (words[0] === 'consolidate') {
    const options = words.slice(1)
    if (options.some(option => option !== '--all')) return { kind: 'error', text: USAGE }
    return consolidator(options.length > 0)
  }
  const [verb, rawId, name] = words
  if (rawId === undefined) return { kind: 'error', text: USAGE }
  if (verb === 'publish') {
    if (words.length !== 2 && (words.length !== 4 || name !== 'as')) return { kind: 'error', text: USAGE }
    const target = words[3] ?? rawId
    const published = await publishDraft(ctx, roots, rawId, target)
    return 'refused' in published
      ? { kind: 'error', text: published.refused }
      : { kind: 'success', text: `Published skill \`${target}\` at ${published.path}; it is live from the next step on.` }
  }
  if (verb === 'discard') {
    return await discardDraft(roots.drafts, rawId)
      ? { kind: 'success', text: `Discarded skill draft ${rawId}.` }
      : { kind: 'error', text: `No skill draft ${rawId}; /learn drafts lists them.` }
  }
  if (verb === 'accept' || verb === 'dismiss') {
    const suggestion = store.getSuggestion(brandString<MemorySuggestionId>(rawId))
    if (suggestion === undefined) return { kind: 'error', text: `No skill suggestion ${rawId}.` }
    if (verb === 'dismiss') {
      await store.setSuggestionStatus(suggestion.id, 'dismissed')
      return { kind: 'success', text: `Dismissed suggestion ${rawId}; its entries will not be proposed together again.` }
    }
    const skillName = name ?? suggestion.name
    if (!SKILL_NAME.test(skillName)) return { kind: 'error', text: SKILL_NAME_HELP }
    const path = await promoteEntries(ctx, store, roots.skills, suggestion.entryIds, skillName)
    await store.setSuggestionStatus(suggestion.id, 'accepted')
    return { kind: 'success', text: `Promoted ${suggestion.entryIds.length} entries to skill \`${skillName}\` at ${path}.` }
  }
  const id = brandString<MemoryEntryId>(rawId)
  const entry = store.get(id)
  if (entry === undefined) return { kind: 'error', text: `No memory entry ${rawId}.` }
  switch (verb) {
    case 'approve': {
      await store.setStatus(id, 'approved')
      return { kind: 'success', text: `Approved ${rawId}; it will be recalled in future sessions.` }
    }
    case 'reject': {
      await store.setStatus(id, 'rejected')
      return { kind: 'success', text: `Rejected ${rawId}; it will not be proposed again.` }
    }
    case 'skill': {
      if (name === undefined || !SKILL_NAME.test(name)) {
        return { kind: 'error', text: SKILL_NAME_HELP }
      }
      const path = await promoteEntry(ctx, store, roots.skills, id, name)
      return { kind: 'success', text: `Promoted ${rawId} to skill \`${name}\` at ${path}.` }
    }
    default:
      return { kind: 'error', text: USAGE }
  }
}
