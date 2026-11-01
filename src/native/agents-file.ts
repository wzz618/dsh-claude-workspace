import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostConfig, ResolvedConfig } from '../config.ts'
import { quotePosix } from '../host/shell.ts'
import { localNativeProvider, nativeAgentIdForHost, sanitizeAgentId } from './routing.ts'

/** Token replaced by the adapter with the shell-quoted session cwd. */
export const REMOTE_CWD_TOKEN = '{cwd}'

/** Marker identifying entries this plugin owns and may refresh. */
const MANAGED_BY_KEY = 'managedBy'
const MANAGED_BY = 'dsh-claude-workspace'

/** One host's outcome within one seeding pass. */
export interface AgentSeedEntry {
  readonly id: string
  readonly hostId: string
  readonly status: 'created' | 'updated' | 'present' | 'skipped' | 'failed'
  readonly reason?: string
}

/** Outcome of offering configured hosts to the ACP adapter's agent table. */
export interface AgentSeedResult {
  readonly status: 'created' | 'updated' | 'present' | 'skipped' | 'failed' | 'partial'
  readonly path: string
  /** Why nothing was written, or the write failure. */
  readonly reason?: string
  readonly entries: readonly AgentSeedEntry[]
}

/**
 * Ensures the ACP adapter's `agents.json` offers this deployment's hosts.
 *
 * The native-session entry creates sessions on `acp-<agentId>`; the adapter
 * only routes providers registered in this table. CCW's host configuration
 * therefore supplies each launcher:
 *
 * - the local host runs the configured executable directly;
 * - an SSH host runs `ssh` with a launcher that `cd`s into the session's remote
 *   cwd (the adapter substitutes {@link REMOTE_CWD_TOKEN}) and execs the remote
 *   binary, while the process itself is spawned in `native.remoteSpawnCwd`.
 *
 * Existing entries with the same id are never overwritten.
 *
 * @param config - Resolved plugin configuration.
 * @returns per-host outcomes plus whether the file was written.
 */
export function seedNativeAgent(config: ResolvedConfig): AgentSeedResult {
  const path = config.native.agentsFile
  if (!config.native.seedAgentsFile) {
    return { status: 'skipped', path, reason: 'native.seedAgentsFile is false', entries: [] }
  }
  if (!config.native.provider.startsWith('acp-')) {
    return {
      status: 'skipped',
      path,
      reason: `native.provider "${config.native.provider}" is not an acp-* route`,
      entries: [],
    }
  }

  let document: Record<string, unknown>
  try {
    document = readDocument(path)
  } catch (error) {
    return { status: 'failed', path, reason: `could not read ${path}: ${messageOf(error)}`, entries: [] }
  }
  const agents = document.agents
  if (!isRecord(agents)) {
    return { status: 'failed', path, reason: `${path} has no "agents" object; leaving it untouched`, entries: [] }
  }

  const entries: AgentSeedEntry[] = []
  let createdSsh = false
  for (const hostId of Object.keys(config.hosts)) {
    const host = config.hosts[hostId]
    if (host === undefined) continue
    const id = host.kind === 'local' ? localNativeProvider(config).slice('acp-'.length) : nativeAgentIdForHost(config, hostId)
    const seeded = host.kind === 'local' ? localEntry(host) : sshEntry(host, config)
    if ('reason' in seeded) {
      entries.push({ id, hostId, status: 'skipped', reason: seeded.reason })
      continue
    }
    const existing = agents[id]
    if (existing !== undefined) {
      // Entries seeded before the marker existed are recognized by the ssh
      // launcher fields this plugin owns; anything else stays manual.
      const managed = isRecord(existing) && (existing[MANAGED_BY_KEY] === MANAGED_BY
        || (host.kind === 'ssh'
          && existing['command'] === config.native.sshCommand
          && existing['cwdToken'] === REMOTE_CWD_TOKEN))
      if (!managed) {
        entries.push({ id, hostId, status: 'present' })
        continue
      }
      agents[id] = seeded.value
      if (host.kind === 'ssh') createdSsh = true
      entries.push({ id, hostId, status: 'updated' })
      continue
    }
    agents[id] = seeded.value
    if (host.kind === 'ssh') createdSsh = true
    entries.push({ id, hostId, status: 'created' })
  }

  const created = entries.some((entry) => entry.status === 'created')
  const updated = entries.some((entry) => entry.status === 'updated')
  const skipped = entries.some((entry) => entry.status === 'skipped')
  if (!created && !updated) {
    return {
      status: skipped ? 'partial' : 'present',
      path,
      ...(skipped ? { reason: 'some hosts were not seeded (see entries)' } : {}),
      entries,
    }
  }
  try {
    if (createdSsh) mkdirSync(config.native.remoteSpawnCwd, { recursive: true, mode: 0o700 })
    writeDocument(path, document)
  } catch (error) {
    return { status: 'failed', path, reason: `could not write ${path}: ${messageOf(error)}`, entries }
  }
  return { status: skipped ? 'partial' : created ? 'created' : 'updated', path, entries }
}

function localEntry(host: HostConfig): { readonly value: Record<string, unknown> } | { readonly reason: string } {
  return {
    value: {
      [MANAGED_BY_KEY]: MANAGED_BY,
      name: 'Claude Code',
      command: host.executable,
      args: [...host.args],
      env: { ...host.env },
    },
  }
}

/**
 * Launcher for one SSH host. The adapter spawns `ssh` in a local directory and
 * replaces {@link REMOTE_CWD_TOKEN} with the session's remote path, so the
 * remote agent starts inside the project without depending on the ssh login
 * directory (project-level `.claude` settings then load as usual).
 */
function sshEntry(
  host: HostConfig,
  config: ResolvedConfig,
): { readonly value: Record<string, unknown> } | { readonly reason: string } {
  if (host.kind !== 'ssh') return { reason: 'not an ssh host' }
  if (host.probeCwd === undefined) {
    return { reason: `hosts.${host.alias ?? 'ssh'}.probeCwd is required for native sessions (remote directory used by the model probe)` }
  }
  const connectSeconds = Math.max(1, Math.ceil(host.connectTimeoutMs / 1000))
  const script = 'cd "$1" && shift && exec "$@"'
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${config.ssh.strictHostKeyChecking ? 'yes' : 'no'}`,
    '-o', `ConnectTimeout=${connectSeconds}`,
    '-o', `ServerAliveInterval=${config.ssh.serverAliveIntervalSec}`,
    '-o', `ServerAliveCountMax=${config.ssh.serverAliveCountMax}`,
    '--',
    host.alias ?? 'ssh',
    'sh', '-lc', quotePosix(script),
    'sh',
    REMOTE_CWD_TOKEN,
    quotePosix(host.executable),
    ...host.args.map((arg) => quotePosix(arg)),
  ]
  const name = `Claude Code (${sanitizeAgentId(host.alias ?? 'ssh')})`
  return {
    value: {
      [MANAGED_BY_KEY]: MANAGED_BY,
      name,
      command: config.native.sshCommand,
      args,
      env: {},
      spawnCwd: config.native.remoteSpawnCwd,
      cwdToken: REMOTE_CWD_TOKEN,
      probeCwd: host.probeCwd,
      cwdMapFile: config.native.cwdMapFile,
    },
  }
}

function readDocument(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { agents: {} }
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error('the file is not a JSON object')
  const agents = parsed.agents ?? {}
  if (!isRecord(agents)) throw new Error('"agents" is not a JSON object')
  return { ...parsed, agents: { ...agents } }
}

function writeDocument(path: string, document: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
