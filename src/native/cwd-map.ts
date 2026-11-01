import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** On-disk shape of the per-session remote cwd table. */
export interface RemoteCwdMapFile {
  readonly version: 1
  readonly sessions: Record<string, string>
}

/**
 * Per-session remote working directories for SSH workspaces.
 *
 * DSH keeps the session cwd equal to its (local) workspace path so workspace
 * attachment and sidebar grouping work. The ACP adapter reads this table at
 * session start and uses the mapped remote path for the launcher and for ACP
 * `session/new`/`load`/`resume`.
 */

/**
 * Record one session's remote cwd before its first turn.
 *
 * @param path - Map file path from `native.cwdMapFile`.
 * @param sessionId - DSH session identity.
 * @param remoteCwd - Absolute directory on the SSH host.
 */
export function writeRemoteCwd(path: string, sessionId: string, remoteCwd: string): void {
  const document = readRemoteCwdMap(path)
  writeRemoteCwdMap(path, { ...document.sessions, [sessionId]: remoteCwd })
}

/** Remove one session entry; a missing file or entry is a no-op. */
export function removeRemoteCwd(path: string, sessionId: string): void {
  const document = readRemoteCwdMap(path)
  if (!Object.hasOwn(document.sessions, sessionId)) return
  const sessions = { ...document.sessions }
  delete sessions[sessionId]
  writeRemoteCwdMap(path, sessions)
}

/**
 * Read the table; a missing or invalid file reads as empty.
 *
 * @param path - Map file path.
 * @returns the parsed document with absolute string entries only.
 */
export function readRemoteCwdMap(path: string): RemoteCwdMapFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { version: 1, sessions: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { version: 1, sessions: {} }
  }
  if (typeof parsed !== 'object' || parsed === null) return { version: 1, sessions: {} }
  const raw = (parsed as { readonly sessions?: unknown }).sessions
  if (typeof raw !== 'object' || raw === null) return { version: 1, sessions: {} }
  const sessions: Record<string, string> = {}
  for (const [sessionId, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.startsWith('/')) sessions[sessionId] = value
  }
  return { version: 1, sessions }
}

function writeRemoteCwdMap(path: string, sessions: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
