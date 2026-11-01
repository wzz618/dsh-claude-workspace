import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { WorkspaceStrategy } from '../config.ts'
import { CcwError } from '../util/errors.ts'

/** Maximum total length of a derived directory name (dsh-im rule). */
export const MAX_DIRECTORY_NAME_LENGTH = 100

/** Characters allowed in the configured prefix. */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Characters kept verbatim in the readable segment. */
const READABLE_PATTERN = /[^A-Za-z0-9_-]+/g

/** Inputs that determine a derived workspace directory. */
export interface DirectoryRequest {
  /** DSH workspace id; stable for the lifetime of the workspace. */
  readonly workspaceId: string
  readonly strategy: WorkspaceStrategy
  /** DSH session id; required by `per-session`. */
  readonly sessionId?: string
  /** Conversation identity; required by `per-conversation`. */
  readonly conversationId?: string
  /** Creation time; makes `per-session` directories unique per session. */
  readonly createdAt: number
  /** Stable identity of the host, typically `local` or `ssh:<alias>`. */
  readonly hostIdentity: string
  /** Absolute derivative root. */
  readonly baseDir: string
  readonly prefix: string
}

/**
 * Derives the directory for a workspace or session.
 *
 * The digest is computed over the host identity, the original identifier, and
 * the base directory. Hashing the original identifier prevents `a:b` and `a-b`
 * from colliding after lossy character replacement. The readable segment is
 * truncated before the digest so the total stays within 100 characters and the
 * digest remains the collation key.
 *
 * @param request - Workspace, host, and strategy inputs.
 * @returns An absolute directory path under `baseDir`.
 * @throws {CcwError} When the prefix is invalid or a required identifier is absent.
 */
export function deriveDirectory(request: DirectoryRequest): string {
  if (!PREFIX_PATTERN.test(request.prefix)) {
    throw new CcwError('config-invalid', `workspace prefix "${request.prefix}" must match [A-Za-z0-9_-]{1,32}`, {
      prefix: request.prefix,
    })
  }
  const identifier = identifierFor(request)
  const digest = createHash('sha256')
    .update(`${request.hostIdentity}\0${identifier}\0${request.baseDir}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
  const readable = readableSegment(identifier)
  const suffix = `-${digest}`
  const budget = MAX_DIRECTORY_NAME_LENGTH - request.prefix.length - suffix.length
  if (budget < 1) {
    throw new CcwError('config-invalid', `workspace prefix "${request.prefix}" leaves no room for a directory name`, {
      prefix: request.prefix,
    })
  }
  return join(request.baseDir, `${request.prefix}${readable.slice(0, budget)}${suffix}`)
}

/**
 * Validates a configured prefix without deriving a directory.
 *
 * @param prefix - Candidate prefix.
 * @returns The prefix, unchanged.
 * @throws {CcwError} When it does not match `[A-Za-z0-9_-]{1,32}`.
 */
export function assertPrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new CcwError('config-invalid', `workspace prefix "${prefix}" must match [A-Za-z0-9_-]{1,32}`, { prefix })
  }
  return prefix
}

/** Returns the original identifier used both for hashing and readability. */
function identifierFor(request: DirectoryRequest): string {
  switch (request.strategy) {
    case 'per-workspace':
      return request.workspaceId
    case 'per-session':
      if (request.sessionId === undefined || request.sessionId.length === 0) {
        throw new CcwError('config-invalid', 'per-session workspace strategy requires a session id', {
          strategy: request.strategy,
        })
      }
      return `${request.workspaceId}:${request.sessionId}:${request.createdAt.toString(36)}`
    case 'per-conversation':
      if (request.conversationId === undefined || request.conversationId.length === 0) {
        throw new CcwError('config-invalid', 'per-conversation workspace strategy requires a conversation id', {
          strategy: request.strategy,
        })
      }
      return `${request.workspaceId}:${request.conversationId}`
  }
}

/** Lossily turns the identifier into a filesystem-readable segment. */
function readableSegment(identifier: string): string {
  const replaced = identifier.replace(READABLE_PATTERN, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  return replaced.length === 0 ? 'ws' : replaced
}
