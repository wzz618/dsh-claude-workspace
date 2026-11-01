/** A structured failure with a stable machine-readable code. */
export type CcwErrorCode =
  | 'config-invalid'
  | 'host-unreachable'
  | 'host-probe-failed'
  | 'dir-create-failed'
  | 'dir-not-found'
  | 'workspace-not-found'
  | 'workspace-registration-failed'
  | 'session-not-found'
  | 'session-open-failed'
  | 'session-load-failed'
  | 'turn-already-running'
  | 'acp-start-failed'
  | 'acp-protocol-error'
  | 'acp-disconnected'
  | 'permission-expired'
  | 'permission-unknown-request'
  | 'settings-invalid'
  | 'settings-write-failed'
  | 'state-invalid'
  | 'widen-unsupported'
  | 'confirmation-required'
  | 'plan-unknown'
  | 'audit-write-failed'

/**
 * Error type used across the plugin. Messages are user-facing and name the
 * next action where one exists; `details` carries non-secret context.
 */
export class CcwError extends Error {
  readonly code: CcwErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: CcwErrorCode, message: string, details: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CcwError'
    this.code = code
    this.details = details
  }
}

/** Returns a short stderr tail suitable for a user-visible error. */
export function tail(text: string, limit = 2000): string {
  if (text.length <= limit) return text
  return `…${text.slice(text.length - limit)}`
}
