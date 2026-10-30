/** Session commands whose activation policy is explicit at each Remote method. */

import { modelAvailable } from './catalog.ts'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId, StagedAttachment } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionLineageNode, type SessionObservation } from '@deepseek-ai/dsh-session-query'
// Type-only: makes the optional persistence service available to `ctx.get('sessionPersistence')`.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: makes the optional sub-agent service available to `ctx.get('subagents')`.
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  type ApiSessionCreated,
} from './agent.ts'
import type {
  SessionDeleteRequest,
  SessionDeleteValue,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionRewindRequest,
  SessionRewindValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
} from './types.ts'

type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

/**
 * Whether prompt content carries non-whitespace text or an attachment.
 * @param content - submitted or edited prompt parts.
 * @returns false for content the Agent must not receive.
 */
export function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Agent composition.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
  ) {}

  /**
   * Create one ordinary Session for a new conversation, reusing the named
   * blank Session while it is an unarchived member of the requested Workspace.
   * @param request - optional blank Session to reuse, location, and Agent preset.
   * @returns the created or reused Session identity and its preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let created: ApiSessionCreated
    try {
      created = await this.agents.createSession({
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        cwd,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        reusable: sessionId => !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
          && (workspace === undefined || workspace.sessionIds.includes(sessionId)),
      })
    } catch (error) {
      this.rejectCreation(error)
    }
    const sessionId = created.agent.id
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId, ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }) }
  }

  /**
   * Validate and record one Session model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection recorded for the Session, without waiting for default persistence.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        await this.requireModel(request)
        const selected: AgentModelSelection = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        }
        await this.ctx.llm.resolveCallConfig(selected)
        agent.model.select(selected)
        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        })
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    using source = await this.observeSource(request.sessionId, 'fork')
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    const seed = buildForkSeed(source.events, boundary)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          // Lineage readers need the source: the Workspace sidebar nests forks under it,
          // a `cascade` delete reaches them, and a rewound child names its origin.
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Rewind: fork at the completed boundary right before the turn that holds
   * `atSeq`, so the child ends where that turn began and its prompt can be
   * resent, edited or not. The first turn has no boundary before it and is
   * refused, as is an anchor past the log's end.
   * @param request - source Session and an event seq inside the turn to rewind to.
   * @returns the child identity plus the rewound turn's first user prompt text.
   */
  async rewind(request: SessionRewindRequest): Promise<SessionRewindValue> {
    let atSeq: ReturnType<typeof SessionSeq>
    try {
      atSeq = SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    const unavailable = (detail: string): RemoteError => new RemoteError(
      'session/rewind-unavailable',
      `session "${request.sessionId}" cannot rewind: ${detail}`,
      { sessionId: request.sessionId },
    )
    let boundarySeq: number
    let prompt: string | undefined
    {
      using source = await this.observeSource(request.sessionId, 'rewind')
      const lastSeq = source.events.at(-1)?.seq ?? -1
      if (atSeq > lastSeq) throw unavailable(`event ${String(atSeq)} is past the end of the log`)
      const start = source.events.findLast(event => event.type === 'turn/start' && event.seq <= atSeq)
      if (start === undefined) throw unavailable(`event ${String(atSeq)} belongs to no turn`)
      const boundary = source.events.findLast(event => event.type === 'turn/end' && event.seq < start.seq)
      if (boundary === undefined) throw unavailable('the first turn has no completed boundary before it')
      boundarySeq = boundary.seq
      prompt = firstUserPromptAfter(source.events, start.seq)
    }
    const { sessionId } = await this.fork({ sessionId: request.sessionId, atSeq: boundarySeq })
    return { sessionId, ...(prompt === undefined ? {} : { prompt }) }
  }

  /**
   * Delete one stored Session and its derived state. A live Session this Host
   * opened is closed first when its turn is settled; one whose turn is running,
   * or one opened by another owner, is refused (`session/live`) and nothing is
   * removed. The sub-agent Sessions it started go with it, deepest first; its
   * forks are kept as Sessions whose parent no longer exists, unless `cascade`
   * is set, which deletes every descendant first. Each removal deletes the stored log,
   * drops the projection-cache row, detaches the Session from its Workspace
   * and the archive set, and announces `api-session/removed` so clients drop
   * the row. The SQLite search index reconciles on its next observation.
   * A deployment that mounts no session persistence refuses before anything
   * is released or closed.
   * @param request - Session identity and cascade choice.
   * @returns every identity removed, descendants before their parents.
   */
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new RemoteError('gateway/internal', 'deleting is unavailable: this deployment mounts no session persistence', {})
    }
    await this.releaseSubagentChild(request.sessionId)
    this.assertClosable(request.sessionId)
    const targets = await this.deleteTargets(request)
    // Refuse before closing anything, so a refusal leaves every target in place.
    for (const id of targets) {
      await this.releaseSubagentChild(id)
      this.assertClosable(id)
    }
    // A Session that was live and never wrote an event has no stored log; once
    // its Agent is closed there is nothing left, which is a removal, not a miss.
    const closed = new Set<SessionId>()
    for (const id of targets) {
      if (await this.agents.close(id) === 'closed') closed.add(id)
    }
    const removed: SessionId[] = []
    for (const id of targets) {
      let result: { readonly deleted: boolean }
      try {
        result = await persistence.delete(id)
      } catch (error) {
        if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
          throw new RemoteError('session/owned', `session "${id}" is owned by another writer`, { sessionId: id })
        }
        throw new RemoteError('gateway/internal', `failed to delete session "${id}": ${String(error)}`, {})
      }
      if (!result.deleted && !closed.has(id) && id === request.sessionId && removed.length === 0) {
        throw new RemoteError('session/not-found', `session "${id}" not found`, { sessionId: id })
      }
      await this.ctx.get('sessionProjectionCache')?.forget(id)
      for (const workspace of this.ctx.workspaceRegistry.list()) {
        if (workspace.sessionIds.includes(id)) await workspace.detachSession(id)
      }
      await this.ctx.workspaceRegistry.unarchiveSession(id)
      this.ctx.emit('api-session/removed', id)
      removed.push(id)
    }
    return { sessionIds: removed }
  }

  private assertClosable(id: SessionId): void {
    const live = this.ctx.agents.get(id)
    if (live === undefined) return
    if (live.status === 'running') {
      throw new RemoteError('session/live', `session "${id}" is running a turn; stop it before deleting`, { sessionId: id })
    }
    if (!this.agents.owns(live)) {
      const parent = live.session.header.parentSession
      const detail = parent === undefined
        ? 'is live under another owner; close it there before deleting'
        : `is a live sub-agent of session "${parent}"; close that session first`
      throw new RemoteError('session/live', `session "${id}" ${detail}`, { sessionId: id })
    }
  }

  /**
   * Release an idle sub-agent child that its live parent still holds, so a
   * delete from the GUI does not need the parent closed first. The child's
   * own turn must be settled; the sub-agent service, when composed, drops the
   * parent's hold on exactly that child. Anything else is left for
   * {@link assertClosable} to refuse.
   * @param id - Session identity about to be deleted.
   */
  private async releaseSubagentChild(id: SessionId): Promise<void> {
    const live = this.ctx.agents.get(id)
    if (live === undefined || live.status === 'running' || this.agents.owns(live)) return
    const parentId = live.session.header.parentSession
    if (parentId === undefined) return
    const parent = this.ctx.agents.get(parentId)
    if (parent === undefined || !this.ctx.agents.isOwnedBy(id, parent)) return
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) return
    await subagents.drainChildren(parent, [id])
  }

  /**
   * Resolve the ordered removal list: the sub-agent Sessions the target
   * started (children through an uninterrupted chain of `origin: 'subagent'`),
   * or every descendant with `cascade`, deepest first, then the target. Forks,
   * and everything under them, are kept without `cascade`.
   * @param request - the delete request.
   * @returns identities in removal order.
   */
  private async deleteTargets(request: SessionDeleteRequest): Promise<SessionId[]> {
    let descendants: SessionLineageNode[] = []
    try {
      descendants = (await this.ctx.sessionQuery.traceSession(request.sessionId)).descendants
    } catch (error) {
      // An unknown target has no lineage; persistence decides whether it exists.
      if (!(error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')) throw error
    }
    const ordered: SessionId[] = []
    const visit = (nodes: SessionLineageNode[]): void => {
      for (const node of nodes) {
        if (request.cascade !== true && node.session.header.origin !== 'subagent') continue
        visit(node.descendants)
        ordered.push(node.session.header.id)
      }
    }
    visit(descendants)
    ordered.push(request.sessionId)
    return ordered
  }

  /**
   * Admit one prompt after Agent and attachment validation; the Remote method
   * has already validated the content and built the durable message source.
   * @param request - Session identity, prompt content, and delivery mode.
   * @param source - the `user-rpc` source recorded on the accepted message.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest, source: MessageSource): Promise<SessionPromptValue> {
    const agent = await this.resolveAgent(request.sessionId)
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true }
    const admission = resolvePromptFileReceipts(
      request.content,
      receiptId => this.ctx.fileUploads.resolve(agent, receiptId),
    )
    // Encoded images and image upload receipts both make an image prompt.
    const hasImage = admission.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        if (hasImage) {
          const current = agent.model.current()
          if (current !== undefined) {
            const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
            if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
              throw new RemoteError(
                'session/attachment-invalid',
                `Model "${current.model}" does not support image input.`,
                { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
              )
            }
          }
        }
        const content = await this.ctx.attachments.admitPromptContent(admission.content)
        const message: UserMessage = createUserMessage({ content, source })
        if (this.ctx.agents.get(agent.id) !== agent) {
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        binding.commit()
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
  }

  /**
   * Read one durable image using the supplied reference without consulting Session history.
   * @param request - image reference and gateway permission scope; Session existence is not checked.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    try {
      const stored = await this.ctx.attachments.readImage(request.attachment)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    switch (request.action.kind) {
      case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      case 'remove': {
        agent.inbox.remove(request.itemId)
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      case 'steer':
        agent.inbox.remove(request.itemId)
        agent.steer(message)
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session: ${String(error)}`, {})
  }

  /**
   * Observe the source Session of a fork or rewind.
   * @param sessionId - the source Session.
   * @param operation - the operation named in an internal failure.
   * @returns the observation, owned by the caller.
   * @throws {RemoteError} `session/not-found` for an unknown Session; `gateway/internal` for any other failure.
   */
  private async observeSource(sessionId: SessionId, operation: 'fork' | 'rewind'): Promise<SessionObservation> {
    try {
      return await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `${operation} source unavailable for session "${sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

/** Replace each file part with the file or image its staged receipt names. */
function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  staged: (receiptId: FileUploadReceiptId) => StagedAttachment | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  const receiptIds = new Set<FileUploadReceiptId>()
  const resolved = content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = staged(part.receiptId)
    if (attachment === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    receiptIds.add(part.receiptId)
    return attachment
  })
  return { content: resolved, receiptIds: [...receiptIds] }
}

function hasPromptRequest(agent: Agent, requestId: SessionRequestId): boolean {
  const matches = (message: UserMessage): boolean => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  }
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return agent.session.snapshotEvents().some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  })
}

/**
 * The text of the first human `user/message` after `afterSeq` and before the
 * next `turn/start`, or `undefined` when that turn holds none.
 * @param events - the observed log in seq order.
 * @param afterSeq - the seq of the turn's `turn/start`.
 * @returns the joined text parts of that message.
 */
function firstUserPromptAfter(events: readonly SessionEvent[], afterSeq: number): string | undefined {
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.type === 'turn/start') return undefined
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .flatMap(part => part.type === 'text' ? [part.text] : [])
      .join('')
    return text.length === 0 ? undefined : text
  }
  return undefined
}
