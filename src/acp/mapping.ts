import type {
  AvailableCommand,
  PlanEntry,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from './types.ts'
import { diffLines, type DiffHunk } from './diff.ts'

/** UI state of one tool card. */
export type ToolCardStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled'

/** One `diff` content block, enriched for rendering. */
export interface DiffBlock {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly added: number
  readonly removed: number
  readonly hunks: readonly DiffHunk[]
  readonly truncated: boolean
}

/** Stable state for one tool call, identified only by `toolCallId`. */
export interface ToolCard {
  readonly toolCallId: string
  readonly title: string
  readonly name?: string | null
  readonly kind: string
  readonly status: ToolCardStatus
  readonly content: readonly ToolCallContent[]
  readonly locations: readonly ToolCallLocation[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  /** Launching tool call when this call ran inside a Claude Code subagent. */
  readonly parentToolCallId?: string
  readonly diffs: readonly DiffBlock[]
  readonly createdAt: number
  readonly updatedAt: number
  /** Sequence of the event that last changed this card. */
  readonly seq: number
}

/** Events the presentation layer renders. */
export type CcwEvent =
  | { readonly type: 'user-text'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly text: string }
  | { readonly type: 'assistant-text'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly text: string }
  | { readonly type: 'thinking'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly text: string }
  | { readonly type: 'tool-call'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly card: ToolCard }
  | { readonly type: 'tool-update'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly card: ToolCard }
  | {
      readonly type: 'plan'
      readonly sessionId: string
      readonly seq: number
      readonly replay: boolean
      readonly entries: readonly PlanEntry[]
    }
  | {
      readonly type: 'commands'
      readonly sessionId: string
      readonly seq: number
      readonly replay: boolean
      readonly commands: readonly AvailableCommand[]
    }
  | { readonly type: 'mode'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly modeId: string }
  | {
      readonly type: 'auto-approved'
      readonly sessionId: string
      readonly seq: number
      readonly replay: boolean
      readonly toolCallId: string
      /** Rule that covered the call, for the card badge. */
      readonly rule: string
    }
  | { readonly type: 'usage'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly data: unknown }
  | {
      readonly type: 'config-option'
      readonly sessionId: string
      readonly seq: number
      readonly replay: boolean
      readonly data: unknown
    }
  | { readonly type: 'unknown'; readonly sessionId: string; readonly seq: number; readonly replay: boolean; readonly update: unknown }

/** Metadata supplied by the runtime for one translated update. */
export interface TranslateMeta {
  /** True while replaying `session/load` history. */
  readonly replay?: boolean
}

/**
 * Translates ACP `session/update` notifications for one DSH session.
 *
 * A tool call produces exactly one card keyed by `toolCallId`; updates mutate
 * that card and never append a second. Title changes are carried as updates
 * because Claude first announces `Preparing file…` and only later names the
 * target path.
 */
export class SessionTranslator {
  readonly #sessionId: string
  readonly #now: () => number
  readonly #cards = new Map<string, ToolCard>()
  #seq = 0

  /**
   * @param sessionId - ACP session id this translator belongs to.
   * @param now - Clock used for card timestamps.
   */
  constructor(sessionId: string, now: () => number = Date.now) {
    this.#sessionId = sessionId
    this.#now = now
  }

  /** Last sequence number emitted. */
  get seq(): number {
    return this.#seq
  }

  /** Current card state, in first-seen order. */
  cards(): ToolCard[] {
    return [...this.#cards.values()]
  }

  /**
   * Translates one agent update.
   *
   * @param update - `session/update` payload.
   * @param meta - Replay marker.
   * @returns Zero or more events in emission order.
   */
  translate(update: SessionUpdate, meta: TranslateMeta = {}): CcwEvent[] {
    const replay = meta.replay === true
    const seq = ++this.#seq
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return [this.#textEvent('user-text', update.content, seq, replay)]
      case 'agent_message_chunk':
        return [this.#textEvent('assistant-text', update.content, seq, replay)]
      case 'agent_thought_chunk':
        return [this.#textEvent('thinking', update.content, seq, replay)]
      case 'tool_call':
        return [this.#toolEvent(update, seq, replay)]
      case 'tool_call_update':
        return [this.#toolEvent(update, seq, replay)]
      case 'plan':
        return [{ type: 'plan', sessionId: this.#sessionId, seq, replay, entries: update.entries ?? [] }]
      case 'available_commands_update':
        return [{ type: 'commands', sessionId: this.#sessionId, seq, replay, commands: update.availableCommands ?? [] }]
      case 'current_mode_update':
        return [{ type: 'mode', sessionId: this.#sessionId, seq, replay, modeId: update.currentModeId }]
      case 'usage_update':
        return [{ type: 'usage', sessionId: this.#sessionId, seq, replay, data: update }]
      case 'config_option_update':
        return [{ type: 'config-option', sessionId: this.#sessionId, seq, replay, data: update }]
      default:
        // Newer agents may add update kinds. Keep them visible instead of
        // dropping them; the UI renders an unknown block.
        return [{ type: 'unknown', sessionId: this.#sessionId, seq, replay, update: update as unknown }]
    }
  }

  /**
   * Marks every running or pending card cancelled and emits updates.
   *
   * ACP reports a cancelled tool as `failed`; the UI keeps the distinction so
   * a user-initiated stop does not look like a tool defect.
   *
   * @returns One `tool-update` per changed card.
   */
  markCancelled(): CcwEvent[] {
    const events: CcwEvent[] = []
    for (const card of this.#cards.values()) {
      if (card.status !== 'pending' && card.status !== 'running') continue
      const seq = ++this.#seq
      const updated: ToolCard = { ...card, status: 'cancelled', updatedAt: this.#now(), seq }
      this.#cards.set(card.toolCallId, updated)
      events.push({ type: 'tool-update', sessionId: this.#sessionId, seq, replay: false, card: updated })
    }
    return events
  }

  #toolEvent(update: ToolCall | ToolCallUpdate, seq: number, replay: boolean): CcwEvent {
    const previous = this.#cards.get(update.toolCallId)
    const now = this.#now()
    const merged = mergeToolCall(previous, update, now, seq)
    this.#cards.set(merged.toolCallId, merged)
    const type = previous === undefined ? 'tool-call' : 'tool-update'
    return { type, sessionId: this.#sessionId, seq, replay, card: merged }
  }

  #textEvent(
    type: 'user-text' | 'assistant-text' | 'thinking',
    content: { readonly type?: unknown; readonly text?: unknown },
    seq: number,
    replay: boolean,
  ): CcwEvent {
    const text = content.type === 'text' && typeof content.text === 'string' ? content.text : ''
    return { type, sessionId: this.#sessionId, seq, replay, text }
  }
}

function mergeToolCall(previous: ToolCard | undefined, update: ToolCall | ToolCallUpdate, now: number, seq: number): ToolCard {
  const content = update.content ?? previous?.content ?? []
  const reported = update.status === undefined ? previous?.status ?? 'pending' : normalizeStatus(update.status)
  const parentToolCallId = parentToolCallIdOf(update) ?? previous?.parentToolCallId
  return {
    toolCallId: update.toolCallId,
    title: update.title ?? previous?.title ?? 'Tool call',
    name: update.name ?? previous?.name,
    kind: update.kind ?? previous?.kind ?? 'other',
    // Cancellation is terminal: Claude reports a cancelled tool as `failed`
    // afterwards, and the UI must keep showing "interrupted".
    status: previous?.status === 'cancelled' ? 'cancelled' : reported,
    content,
    locations: update.locations ?? previous?.locations ?? [],
    ...(update.rawInput === undefined ? (previous?.rawInput === undefined ? {} : { rawInput: previous.rawInput }) : { rawInput: update.rawInput }),
    ...(update.rawOutput === undefined ? (previous?.rawOutput === undefined ? {} : { rawOutput: previous.rawOutput }) : { rawOutput: update.rawOutput }),
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
    diffs: extractDiffs(content),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    seq,
  }
}

/** Reads Claude Code's subagent launch identity from a tool call's `_meta`. */
function parentToolCallIdOf(update: ToolCall | ToolCallUpdate): string | undefined {
  const claudeCode = update._meta?.claudeCode
  if (typeof claudeCode !== 'object' || claudeCode === null) return undefined
  const parentToolUseId = (claudeCode as { readonly parentToolUseId?: unknown }).parentToolUseId
  return typeof parentToolUseId === 'string' && parentToolUseId.length > 0 ? parentToolUseId : undefined
}

/** Maps ACP tool status onto the card state machine. */
export function normalizeStatus(status: string): ToolCardStatus {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'ok'
    case 'failed':
      return 'failed'
    default:
      return 'pending'
  }
}

/** Extracts structured diff blocks and computes their line-level hunks. */
export function extractDiffs(content: readonly ToolCallContent[]): DiffBlock[] {
  const diffs: DiffBlock[] = []
  for (const entry of content) {
    if (entry.type !== 'diff') continue
    const oldText = entry.oldText ?? ''
    const result = diffLines(oldText, entry.newText)
    diffs.push({
      path: entry.path,
      oldText,
      newText: entry.newText,
      added: result.added,
      removed: result.removed,
      hunks: result.hunks,
      truncated: result.truncated,
    })
  }
  return diffs
}
