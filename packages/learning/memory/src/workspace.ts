/**
 * The project an entry was learned in, carried as a tag so recall can rank a
 * project's own notes first. The tag is never indexed for matching and never
 * shown: its path words would match requests that only mention a folder.
 * @module
 */

const WORKSPACE_TAG_PREFIX = 'workspace:'

/**
 * The tag naming a workspace, lowercased like every stored tag.
 * @param cwd - the workspace's directory.
 * @returns `workspace:<directory>`.
 */
export function workspaceTag(cwd: string): string {
  return `${WORKSPACE_TAG_PREFIX}${cwd.toLowerCase()}`
}

/**
 * Whether a tag names a workspace.
 * @param tag - a stored tag.
 * @returns `true` for a {@link workspaceTag}.
 */
export function isWorkspaceTag(tag: string): boolean {
  return tag.startsWith(WORKSPACE_TAG_PREFIX)
}

/**
 * The tags a person or model sees and matches against: every tag but the workspace one.
 * @param tags - an entry's stored tags.
 * @returns the tags without {@link workspaceTag}s.
 */
export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter(tag => !isWorkspaceTag(tag))
}
