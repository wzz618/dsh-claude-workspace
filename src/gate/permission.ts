import { randomUUID } from 'node:crypto'
import { CcwError } from '../util/errors.ts'
import type { PermissionOption, ToolCallUpdate } from '../acp/types.ts'

/** Lifecycle of one permission request held by the Host. */
export type PermissionRequestStatus = 'pending' | 'answered' | 'expired'

/** A request the UI can render and answer. */
export interface PendingPermission {
  readonly requestId: string
  /** ACP session id. */
  readonly sessionId: string
  /** Correlates the request with a DSH session. */
  readonly dshSessionId?: string
  readonly workspaceId?: string
  readonly toolCall: ToolCallUpdate
  /** Claude's options, forwarded unchanged. */
  readonly options: readonly PermissionOption[]
  readonly status: PermissionRequestStatus
  readonly createdAt: number
  readonly answeredAt?: number
  readonly optionId?: string
  /** Why the request is no longer answerable. */
  readonly expiredReason?: string
  /** True when the request arrived during `session/load` replay. */
  readonly replay: boolean
}

/** Resolution of one pending request. */
export type GateDecision =
  | { readonly kind: 'option'; readonly optionId: string }
  | { readonly kind: 'expired'; readonly reason: string }

export interface PermissionRequestInput {
  readonly sessionId: string
  readonly dshSessionId?: string
  readonly workspaceId?: string
  readonly toolCall: ToolCallUpdate
  readonly options: readonly PermissionOption[]
  readonly replay?: boolean
}

export interface PermissionGateOptions {
  /**
   * Milliseconds before a pending request is expired. 0 means it stays
   * pending until the user answers (design decision B1).
   */
  readonly timeoutMs: number
  readonly now?: () => number
  /** Called whenever the pending/answered set changes. */
  readonly onChange?: (pending: readonly PendingPermission[]) => void
}

interface HeldRequest {
  record: PendingPermission
  readonly resolve: (decision: GateDecision) => void
  readonly promise: Promise<GateDecision>
  readonly timer: NodeJS.Timeout | undefined
  readonly dedupeKey: string
}

/**
 * Holds permission requests until a user or caller answers them.
 *
 * Requests live in Host memory and are never persisted: a page refresh
 * re-attaches to the same Host process and sees them again, while a Host
 * restart expires them. That distinction is deliberate (B4) and is why a
 * pending request is never silently replayed to the agent.
 */
export class PermissionGate {
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #onChange: ((pending: readonly PendingPermission[]) => void) | undefined
  readonly #held = new Map<string, HeldRequest>()
  readonly #byDedupeKey = new Map<string, string>()
  readonly #history = new Map<string, PendingPermission>()
  #counter = 0

  constructor(options: PermissionGateOptions) {
    this.#timeoutMs = options.timeoutMs
    this.#now = options.now ?? Date.now
    this.#onChange = options.onChange
  }

  /**
   * Registers a permission request and returns a promise for its decision.
   *
   * A repeated request for the same session and tool call returns the existing
   * decision promise instead of creating a second card.
   *
   * @param input - Claude's options and tool call.
   * @returns The decision, or `expired` when the connection or timeout ends it.
   */
  request(input: PermissionRequestInput): Promise<GateDecision> {
    const dedupeKey = `${input.sessionId}:${input.toolCall.toolCallId}`
    const existingId = this.#byDedupeKey.get(dedupeKey)
    if (existingId !== undefined) {
      const existing = this.#held.get(existingId)
      if (existing !== undefined) return existing.promise
    }
    const requestId = `perm_${(this.#counter += 1).toString(36)}_${randomUUID().slice(0, 8)}`
    let resolveDecision!: (decision: GateDecision) => void
    const promise = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve
    })
    const record: PendingPermission = {
      requestId,
      sessionId: input.sessionId,
      ...(input.dshSessionId === undefined ? {} : { dshSessionId: input.dshSessionId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      toolCall: input.toolCall,
      options: input.options,
      status: 'pending',
      createdAt: this.#now(),
      replay: input.replay === true,
    }
    const timer = this.#timeoutMs > 0
      ? setTimeout(() => this.expire(requestId, `timed out after ${this.#timeoutMs} ms`), this.#timeoutMs)
      : undefined
    timer?.unref?.()
    const held: HeldRequest = { record, resolve: resolveDecision, promise, timer, dedupeKey }
    this.#held.set(requestId, held)
    this.#byDedupeKey.set(dedupeKey, requestId)
    this.#history.set(requestId, record)
    this.#notify()
    return promise
  }

  /**
   * Answers a pending request with one of Claude's option ids.
   *
   * @param requestId - Request to answer.
   * @param optionId - One of the request's own option ids.
   * @throws {CcwError} When the request is unknown or the option is not part of it.
   */
  answer(requestId: string, optionId: string): void {
    const held = this.#held.get(requestId)
    if (held === undefined) {
      throw new CcwError('permission-unknown-request', `permission request ${requestId} is not pending`, { requestId })
    }
    if (!held.record.options.some((option) => option.optionId === optionId)) {
      throw new CcwError('permission-unknown-request', `option "${optionId}" does not belong to request ${requestId}`, {
        requestId,
        optionId,
      })
    }
    this.#settle(held, { kind: 'option', optionId }, 'answered', optionId)
  }

  /** Expires one request, for example when its agent connection drops. */
  expire(requestId: string, reason: string): void {
    const held = this.#held.get(requestId)
    if (held === undefined) return
    this.#settle(held, { kind: 'expired', reason }, 'expired')
  }

  /** Expires every pending request, optionally limited to one ACP session or workspace. */
  expireAll(reason: string, filter: { readonly sessionId?: string; readonly workspaceId?: string } = {}): void {
    for (const held of [...this.#held.values()]) {
      if (filter.sessionId !== undefined && held.record.sessionId !== filter.sessionId) continue
      if (filter.workspaceId !== undefined && held.record.workspaceId !== filter.workspaceId) continue
      this.#settle(held, { kind: 'expired', reason }, 'expired')
    }
  }

  /** Pending requests, optionally for one ACP session. */
  pending(sessionId?: string): PendingPermission[] {
    return [...this.#held.values()]
      .map((held) => held.record)
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
  }

  /** A request by id, including answered and expired records. */
  get(requestId: string): PendingPermission | undefined {
    return this.#history.get(requestId)
  }

  /** Ends every request and stops emitting change notifications. */
  dispose(): void {
    this.expireAll('plugin disposed')
  }

  #settle(
    held: HeldRequest,
    decision: GateDecision,
    status: 'answered' | 'expired',
    optionId?: string,
  ): void {
    if (held.record.status !== 'pending') return
    if (held.timer !== undefined) clearTimeout(held.timer)
    this.#held.delete(held.record.requestId)
    this.#byDedupeKey.delete(held.dedupeKey)
    const settled: PendingPermission = {
      ...held.record,
      status,
      answeredAt: this.#now(),
      ...(optionId === undefined ? {} : { optionId }),
      ...(decision.kind === 'expired' ? { expiredReason: decision.reason } : {}),
    }
    this.#history.set(held.record.requestId, settled)
    this.#notify()
    held.resolve(decision)
  }

  #notify(): void {
    this.#onChange?.(this.pending())
  }
}
