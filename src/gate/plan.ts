import type { PlanEntry } from '../acp/types.ts'
import { CcwError } from '../util/errors.ts'

/** Latest plan reported by one agent session. */
export interface PlanSnapshot {
  readonly sessionId: string
  readonly entries: readonly PlanEntry[]
  readonly receivedAt: number
  readonly replay: boolean
  decision?: PlanDecision
}

/** User decision on a plan card. */
export type PlanDecision =
  | { readonly kind: 'approve'; readonly feedback?: string }
  | { readonly kind: 'revise'; readonly feedback: string }
  | { readonly kind: 'cancel' }

export interface PlanGateOptions {
  readonly now?: () => number
  readonly onChange?: (plans: readonly PlanSnapshot[]) => void
}

/**
 * Tracks plan updates so the UI can show the latest plan and its decision.
 *
 * Approval itself is carried back to Claude as a prompt (feedback) or a
 * cancellation; ACP has no separate plan-approval verb. This class owns only
 * the presentation state and the decision record.
 */
export class PlanGate {
  readonly #plans = new Map<string, PlanSnapshot>()
  readonly #now: () => number
  readonly #onChange: ((plans: readonly PlanSnapshot[]) => void) | undefined

  constructor(options: PlanGateOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#onChange = options.onChange
  }

  /** Applies a `plan` update to one session. */
  record(sessionId: string, entries: readonly PlanEntry[], replay = false): PlanSnapshot {
    const snapshot: PlanSnapshot = { sessionId, entries: [...entries], receivedAt: this.#now(), replay }
    this.#plans.set(sessionId, snapshot)
    this.#notify()
    return snapshot
  }

  /** Returns the latest plan for one session. */
  get(sessionId: string): PlanSnapshot | undefined {
    return this.#plans.get(sessionId)
  }

  /** Plans that still have no decision. */
  pending(): PlanSnapshot[] {
    return [...this.#plans.values()].filter((plan) => plan.decision === undefined)
  }

  /**
   * Records a decision and returns the snapshot.
   *
   * @param sessionId - ACP session id.
   * @param decision - Approve, revise, or cancel.
   * @throws {CcwError} When the session has no recorded plan.
   */
  decide(sessionId: string, decision: PlanDecision): PlanSnapshot {
    const existing = this.#plans.get(sessionId)
    if (existing === undefined) {
      throw new CcwError('plan-unknown', `no plan is recorded for session ${sessionId}`, { sessionId })
    }
    const updated: PlanSnapshot = { ...existing, decision }
    this.#plans.set(sessionId, updated)
    this.#notify()
    return updated
  }

  /** Drops presentation state for one session. */
  forget(sessionId: string): void {
    this.#plans.delete(sessionId)
    this.#notify()
  }

  #notify(): void {
    this.#onChange?.([...this.#plans.values()])
  }
}
