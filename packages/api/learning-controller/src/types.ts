/** Remote values of the learning namespace: plain JSON projections of memory entries. */

/** One memory entry as the Client sees it. */
export interface LearningEntryView {
  /** Stable entry id. */
  id: string
  /** The remembered text. */
  text: string
  /** Free-form tags. */
  tags: string[]
  /** What kind of knowledge the entry holds. */
  kind: 'fact' | 'shortcut' | 'preference'
  /** Review and curation state. */
  status: 'candidate' | 'approved' | 'promoted' | 'rejected' | 'stale' | 'archived'
  /** Session whose work produced the entry, when known. */
  sourceSessionId?: string
  /** ISO creation time. */
  createdAt: string
  /** ISO time of the last status change. */
  updatedAt: string
}

/** Everything the card renders: what awaits review and what the model is shown. */
export interface LearningSnapshot {
  /** Extractor proposals awaiting a human decision, oldest first. */
  candidates: LearningEntryView[]
  /** Approved and promoted entries the model recalls, oldest first. */
  recalled: LearningEntryView[]
  /** Entries the curator retired from recall (stale) or from search (archived), oldest first. */
  curated: LearningEntryView[]
}

/** Counts of what one curation run changed. */
export interface LearningCurateValue {
  /** Entries that turned stale. */
  stale: number
  /** Entries that turned archived, including merged duplicates. */
  archived: number
  /** Duplicate pairs merged. */
  merged: number
  /** Skill suggestions written. */
  suggested: number
}

/** A review decision on one candidate. */
export interface LearningReviewRequest {
  /** The candidate entry id. */
  id: string
  /** Approve recalls it in future sessions; reject hides it for good. */
  decision: 'approve' | 'reject'
}

/** Forget one entry. */
export interface LearningForgetRequest {
  /** The entry id. */
  id: string
}

/** Whether a forget removed an entry. */
export interface LearningForgetValue {
  /** True when an entry was deleted. */
  removed: boolean
}

/** One curator-proposed cluster of remembered entries that could become a skill. */
export interface LearningSuggestionView {
  /** Stable suggestion id. */
  id: string
  /** Proposed skill name: lowercase letters, digits, and single hyphens. */
  name: string
  /** The entries in the cluster, oldest first; entries deleted since are left out. */
  entries: LearningEntryView[]
  /** ISO creation time. */
  createdAt: string
  /** Review state. */
  status: 'proposed' | 'accepted' | 'dismissed'
}

/** The suggestions awaiting a decision. */
export interface LearningSuggestionsValue {
  /** Proposed suggestions, oldest first. */
  suggestions: LearningSuggestionView[]
}

/** Accept one suggestion, optionally under another skill name. */
export interface LearningAcceptSuggestionRequest {
  /** The suggestion id. */
  id: string
  /** Skill name; omitted uses the proposed name. */
  name?: string
}

/** Where the accepted suggestion's skill was written. */
export interface LearningAcceptSuggestionValue {
  /** Absolute path of the written `SKILL.md`. */
  path: string
  /** The skill name used. */
  name: string
}

/** Dismiss one suggestion so its cluster is not proposed again. */
export interface LearningDismissSuggestionRequest {
  /** The suggestion id. */
  id: string
}

/** Promote one entry to a skill. */
export interface LearningPromoteRequest {
  /** The entry id. */
  id: string
  /** Skill name: lowercase letters, digits, and single hyphens. */
  name: string
}

/** Where the promoted skill was written. */
export interface LearningPromoteValue {
  /** Absolute path of the written `SKILL.md`. */
  path: string
}

/** Edit one entry's text or tags in place. */
export interface LearningUpdateRequest {
  /** The entry id. */
  id: string
  /** New text; omitted keeps the current text. */
  text?: string
  /** New tags; omitted keeps the current tags. */
  tags?: string[]
}

/** One skill under the learning skills root. */
export interface LearningSkillView {
  /** Directory name, which is the skill name. */
  name: string
  /** The frontmatter `description`, else the first heading, else the name. */
  description: string
  /** Absolute path of the `SKILL.md`. */
  path: string
  /** File size in bytes. */
  bytes: number
}

/** The skills the learning plugin wrote. */
export interface LearningSkillsValue {
  /** Skills sorted by name. */
  skills: LearningSkillView[]
}

/** Read one skill file. */
export interface LearningReadSkillRequest {
  /** The skill name. */
  name: string
}

/** One skill file's contents. */
export interface LearningReadSkillValue {
  /** The file contents, or `null` when no such skill exists. */
  content: string | null
}

/** Replace one skill file. */
export interface LearningWriteSkillRequest {
  /** The skill name. */
  name: string
  /** The complete file contents. */
  content: string
}

/** Where the skill was written. */
export interface LearningWriteSkillValue {
  /** Absolute path of the written `SKILL.md`. */
  path: string
}

/** Delete one skill. */
export interface LearningDeleteSkillRequest {
  /** The skill name. */
  name: string
}

/** Whether a skill was deleted. */
export interface LearningDeleteSkillValue {
  /** True when a skill directory existed and was removed. */
  removed: boolean
}
