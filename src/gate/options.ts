import type { PermissionOption } from '../acp/types.ts'

/** Normalizes option kinds across the hyphen/underscore spellings agents use. */
export function normalizeOptionKind(kind: string): string {
  return kind.replaceAll('-', '_')
}

/** Finds Claude's one-time allow option. */
export function findAllowOnce(options: readonly PermissionOption[]): PermissionOption | undefined {
  return options.find((option) => normalizeOptionKind(option.kind) === 'allow_once')
}

/**
 * Finds Claude's "allow and update settings" option.
 *
 * Claude 2.1.314 reports this option with `kind: "allow_always"` and
 * `optionId: "allow-with-updates"`; other ACP agents use
 * `kind: "allow_with_updates"`. Both forms name the same choice: the agent
 * decides whether and where to persist the grant, so CCW forwards whichever
 * one is present.
 */
export function findAllowWithUpdates(options: readonly PermissionOption[]): PermissionOption | undefined {
  return options.find((option) => normalizeOptionKind(option.kind) === 'allow_with_updates')
    ?? options.find((option) => normalizeOptionKind(option.kind) === 'allow_always'
      && /(?:^|[-_])with[-_]updates$/i.test(option.optionId))
    ?? options.find((option) => normalizeOptionKind(option.kind) === 'allow_always')
}

/** Finds the first rejecting option, preferring one-time rejection. */
export function findReject(options: readonly PermissionOption[]): PermissionOption | undefined {
  return options.find((option) => normalizeOptionKind(option.kind) === 'reject_once')
    ?? options.find((option) => normalizeOptionKind(option.kind) === 'reject_always')
}

/** True when the option grants access. */
export function isAllowOption(option: PermissionOption): boolean {
  const kind = normalizeOptionKind(option.kind)
  return kind === 'allow_once' || kind === 'allow_always' || kind === 'allow_with_updates'
}

/** Commands that require an explicit confirmation before widening a grant. */
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[^\n]*[rf][^\n]*\s+\/(?:\s|$)/i,
  /\brm\s+-[^\n]*[rf][^\n]*\s+~\//i,
  /\bsudo\b/i,
  /\bdd\s+if=/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i,
  /\bchmod\s+(?:-R\s+)?777\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(?:sd|nvme|hd)/i,
  /:\(\)\s*\{/,
  /\bgit\s+push\b[^\n]*--force\b/i,
  /\bshutdown\b|\breboot\b/i,
]

/** True when a Bash command matches a destructive or privilege-escalation shape. */
export function isHighRiskCommand(command: string | undefined): boolean {
  if (command === undefined || command.length === 0) return false
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command))
}
