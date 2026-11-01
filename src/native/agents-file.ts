import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostConfig, ResolvedConfig } from '../config.ts'

/** Outcome of offering the local host to the ACP adapter's agent table. */
export interface AgentSeedResult {
  readonly status: 'created' | 'present' | 'skipped' | 'failed'
  readonly path: string
  /** Why nothing was written, or the write failure. */
  readonly reason?: string
}

/**
 * Ensures the ACP adapter's `agents.json` offers this deployment's local host.
 *
 * The native-session entry creates sessions on provider `acp-<agentId>`; the
 * adapter only routes providers registered in this table. CCW's local host
 * configuration therefore supplies the executable and arguments, and the file
 * stays authoritative for anything already configured: an existing entry with
 * the same id is never overwritten.
 *
 * @param config - Resolved plugin configuration.
 * @returns whether an entry was created, already present, skipped, or failed.
 */
export function seedNativeAgent(config: ResolvedConfig): AgentSeedResult {
  const path = config.native.agentsFile
  if (!config.native.seedAgentsFile) return { status: 'skipped', path, reason: 'native.seedAgentsFile is false' }
  if (!config.native.provider.startsWith('acp-')) {
    return { status: 'skipped', path, reason: `native.provider "${config.native.provider}" is not an acp-* route` }
  }
  const agentId = config.native.provider.slice('acp-'.length)
  if (agentId.length === 0) return { status: 'skipped', path, reason: 'native.provider names no agent id' }
  const host = localHost(config)
  if (host === undefined) return { status: 'skipped', path, reason: 'no local host is configured' }

  let document: Record<string, unknown>
  try {
    document = readDocument(path)
  } catch (error) {
    return { status: 'failed', path, reason: `could not read ${path}: ${messageOf(error)}` }
  }
  const agents = document.agents
  if (!isRecord(agents)) {
    return { status: 'failed', path, reason: `${path} has no "agents" object; leaving it untouched` }
  }
  if (Object.hasOwn(agents, agentId)) return { status: 'present', path }

  agents[agentId] = {
    name: agentId === 'claude-code' ? 'Claude Code' : agentId,
    command: host.executable,
    args: [...host.args],
    env: { ...host.env },
  }
  try {
    writeDocument(path, document)
  } catch (error) {
    return { status: 'failed', path, reason: `could not write ${path}: ${messageOf(error)}` }
  }
  return { status: 'created', path }
}

function localHost(config: ResolvedConfig): HostConfig | undefined {
  const preferred = config.hosts[config.defaultHost]
  if (preferred?.kind === 'local') return preferred
  return Object.values(config.hosts).find((host) => host.kind === 'local')
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
