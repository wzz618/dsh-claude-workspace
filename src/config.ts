import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Directory-derivation policy for a workspace's Claude Code cwd. */
export type WorkspaceStrategy = 'per-workspace' | 'per-session' | 'per-conversation'

/** How far a user-chosen "widen" grant reaches beyond the current command. */
export type WidenScope = 'command' | 'prefix' | 'tool'

/** One host Claude Code can run on. */
export interface HostConfig {
  readonly kind: 'local' | 'ssh'
  /** SSH alias from `~/.ssh/config`; absent for local hosts. */
  readonly alias?: string
  /** ACP executable name resolved on the host's PATH. */
  readonly executable: string
  readonly args: readonly string[]
  /**
   * Explicit shell command run on the remote host instead of
   * `<executable> <args>`. The plan reserves this for deployments that must
   * `cd` or wrap the executable; the default does not use a shell.
   */
  readonly command?: string
  readonly env: Readonly<Record<string, string>>
  readonly connectTimeoutMs: number
}

/** Fully resolved plugin configuration; every deployment choice is explicit. */
export interface ResolvedConfig {
  readonly dataDir: string
  readonly hosts: Readonly<Record<string, HostConfig>>
  readonly defaultHost: string
  readonly workspaces: {
    readonly baseDir: string
    readonly strategy: WorkspaceStrategy
    readonly prefix: string
  }
  readonly acp: {
    readonly executable: string
    readonly handshakeTimeoutMs: number
    /** Timeout for control requests; 0 means no timeout. */
    readonly requestTimeoutMs: number
    /** `session/prompt` duration is user-controlled; 0 means no timeout. */
    readonly promptTimeoutMs: number
    readonly idleRecycleMs: number
    readonly maxLineBytes: number
    /** Lowest accepted `claude-agent-acp` version. */
    readonly minimumVersion: string
    /** First rejected version (exclusive upper bound). */
    readonly maximumVersionExclusive: string
  }
  readonly events: {
    /** Events retained in Host memory for re-attach after a page refresh. */
    readonly bufferSize: number
  }
  readonly approvals: {
    /** 0 keeps a permission request pending until the user answers. */
    readonly timeoutMs: number
    readonly showSessionBadge: boolean
  }
  readonly permissions: {
    /** B5: Claude's option set is forwarded unchanged; disabling is a config error. */
    readonly forwardClaudeOptions: true
    readonly widen: {
      readonly enabled: boolean
      readonly defaultScope: WidenScope
    }
    readonly persist: {
      readonly target: 'project' | 'user'
      readonly confirmUserScope: boolean
    }
  }
  readonly audit: {
    readonly dir: string
    readonly retainDays: number
  }
  readonly logs: {
    readonly dir: string
    readonly maxBytes: number
    readonly files: number
  }
  readonly ssh: {
    readonly connectTimeoutMs: number
    readonly serverAliveIntervalSec: number
    readonly serverAliveCountMax: number
    readonly strictHostKeyChecking: boolean
  }
  readonly native: {
    /** Provider route the ACP adapter registers for the Claude Code profile. */
    readonly provider: string
    /** Model id sent with the first request; `default` follows the agent's own default. */
    readonly model: string
    /** Permission preset written into a session created by the native entry. */
    readonly permissionPreset: string
    /** Attach the new session to its DSH workspace so the sidebar shows it. */
    readonly attachToWorkspace: boolean
  }
}

/** Raw Loader configuration accepted by the plugin. */
export interface CcwConfigInput {
  dataDir?: string
  hosts?: Record<string, HostConfigInput>
  defaultHost?: string
  workspaces?: {
    baseDir?: string
    strategy?: WorkspaceStrategy
    prefix?: string
  }
  acp?: {
    executable?: string
    handshakeTimeoutMs?: number
    requestTimeoutMs?: number
    promptTimeoutMs?: number
    idleRecycleMs?: number
    maxLineBytes?: number
    minimumVersion?: string
    maximumVersionExclusive?: string
  }
  events?: {
    bufferSize?: number
  }
  approvals?: {
    timeoutMs?: number
    showSessionBadge?: boolean
  }
  permissions?: {
    forwardClaudeOptions?: boolean
    widen?: {
      enabled?: boolean
      defaultScope?: WidenScope
    }
    persist?: {
      target?: 'project' | 'user'
      confirmUserScope?: boolean
    }
  }
  audit?: {
    dir?: string
    retainDays?: number
  }
  logs?: {
    dir?: string
    maxBytes?: number
    files?: number
  }
  ssh?: {
    connectTimeoutMs?: number
    serverAliveIntervalSec?: number
    serverAliveCountMax?: number
    strictHostKeyChecking?: boolean
  }
  native?: {
    provider?: string
    model?: string
    permissionPreset?: string
    attachToWorkspace?: boolean
  }
}

/** One host entry as written in cordis.yml. */
export interface HostConfigInput {
  kind?: 'local' | 'ssh'
  alias?: string
  executable?: string
  args?: string[]
  command?: string
  env?: Record<string, string>
  connectTimeoutMs?: number
}

/** A configuration rejection that names every invalid field at once. */
export class CcwConfigError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`invalid dsh-claude-workspace configuration:\n- ${issues.join('\n- ')}`)
    this.name = 'CcwConfigError'
    this.issues = issues
  }
}

const STRATEGIES: readonly WorkspaceStrategy[] = ['per-workspace', 'per-session', 'per-conversation']
const WIDEN_SCOPES: readonly WidenScope[] = ['command', 'prefix', 'tool']
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Resolves Loader configuration into the explicit values the runtime uses.
 *
 * Missing fields take documented defaults; invalid fields are collected and
 * reported together instead of silently falling back. Relative paths are
 * rejected because workspace directories are compared across processes and
 * hosts.
 *
 * @param input - Configuration map from cordis.yml, possibly empty.
 * @param env - Process environment used for `DSH_HOME` and home expansion.
 * @returns The resolved configuration.
 * @throws {CcwConfigError} When any field is invalid.
 */
export function resolveConfig(input: CcwConfigInput | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const issues: string[] = []
  const raw = isRecord(input) ? input : {}
  rejectUnknownKeys(raw, ['dataDir', 'hosts', 'defaultHost', 'workspaces', 'acp', 'events', 'approvals', 'permissions', 'audit', 'logs', 'ssh', 'native'], 'config', issues)

  const home = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  const dataDir = pathField(raw.dataDir, join(home, 'claude-code'), 'dataDir', env, issues)

  const ssh = section(raw.ssh, ['connectTimeoutMs', 'serverAliveIntervalSec', 'serverAliveCountMax', 'strictHostKeyChecking'], 'ssh', issues)
  const sshConfig = {
    connectTimeoutMs: numberField(ssh.connectTimeoutMs, 8000, 'ssh.connectTimeoutMs', issues, 1),
    serverAliveIntervalSec: numberField(ssh.serverAliveIntervalSec, 15, 'ssh.serverAliveIntervalSec', issues, 1),
    serverAliveCountMax: numberField(ssh.serverAliveCountMax, 3, 'ssh.serverAliveCountMax', issues, 1),
    strictHostKeyChecking: booleanField(ssh.strictHostKeyChecking, true, 'ssh.strictHostKeyChecking', issues),
  }

  const acp = section(raw.acp, ['executable', 'handshakeTimeoutMs', 'requestTimeoutMs', 'promptTimeoutMs', 'idleRecycleMs', 'maxLineBytes', 'minimumVersion', 'maximumVersionExclusive'], 'acp', issues)
  const minimumVersion = versionField(acp.minimumVersion, '0.99.0', 'acp.minimumVersion', issues)
  const maximumVersionExclusive = versionField(acp.maximumVersionExclusive, '1.0.0', 'acp.maximumVersionExclusive', issues)
  if (compareVersions(minimumVersion, maximumVersionExclusive) >= 0) {
    issues.push('acp.minimumVersion must be lower than acp.maximumVersionExclusive')
  }
  const acpConfig = {
    executable: stringField(acp.executable, 'claude-agent-acp', 'acp.executable', issues),
    handshakeTimeoutMs: numberField(acp.handshakeTimeoutMs, 20_000, 'acp.handshakeTimeoutMs', issues, 1),
    requestTimeoutMs: numberField(acp.requestTimeoutMs, 30_000, 'acp.requestTimeoutMs', issues, 0),
    promptTimeoutMs: numberField(acp.promptTimeoutMs, 0, 'acp.promptTimeoutMs', issues, 0),
    idleRecycleMs: numberField(acp.idleRecycleMs, 600_000, 'acp.idleRecycleMs', issues, 0),
    maxLineBytes: numberField(acp.maxLineBytes, 8 * 1024 * 1024, 'acp.maxLineBytes', issues, 65_536),
    minimumVersion,
    maximumVersionExclusive,
  }
  const eventsConfig = section(raw.events, ['bufferSize'], 'events', issues)
  const events = {
    bufferSize: numberField(eventsConfig.bufferSize, 5000, 'events.bufferSize', issues, 1),
  }

  const hostsRaw = raw.hosts === undefined ? { local: { kind: 'local' } } : isRecord(raw.hosts) ? raw.hosts : (issues.push('hosts must be an object keyed by host id'), {})
  const hosts: Record<string, HostConfig> = {}
  if (Object.keys(hostsRaw).length === 0) issues.push('hosts must declare at least one host')
  for (const [id, value] of Object.entries(hostsRaw)) {
    const host = resolveHost(id, value, acpConfig.executable, sshConfig.connectTimeoutMs, issues)
    if (host) hosts[id] = host
  }

  const defaultHost = stringField(raw.defaultHost, 'local', 'defaultHost', issues)
  if (!Object.hasOwn(hosts, defaultHost) && Object.keys(hostsRaw).length > 0) {
    issues.push(`defaultHost "${defaultHost}" is not declared in hosts`)
  }

  const ws = section(raw.workspaces, ['baseDir', 'strategy', 'prefix'], 'workspaces', issues)
  const strategy = enumField(ws.strategy, 'per-workspace', STRATEGIES, 'workspaces.strategy', issues)
  const prefix = stringField(ws.prefix, 'cc-', 'workspaces.prefix', issues)
  if (!PREFIX_PATTERN.test(prefix)) issues.push('workspaces.prefix must match [A-Za-z0-9_-]{1,32}')

  const approvalsRaw = section(raw.approvals, ['timeoutMs', 'showSessionBadge'], 'approvals', issues)
  const approvalsConfig = {
    timeoutMs: numberField(approvalsRaw.timeoutMs, 0, 'approvals.timeoutMs', issues, 0),
    showSessionBadge: booleanField(approvalsRaw.showSessionBadge, true, 'approvals.showSessionBadge', issues),
  }
  const permissionsRaw = section(raw.permissions, ['forwardClaudeOptions', 'widen', 'persist'], 'permissions', issues)
  const widenRaw = section(permissionsRaw.widen, ['enabled', 'defaultScope'], 'permissions.widen', issues)
  const persistRaw = section(permissionsRaw.persist, ['target', 'confirmUserScope'], 'permissions.persist', issues)

  const forwardClaudeOptions = booleanField(permissionsRaw.forwardClaudeOptions, true, 'permissions.forwardClaudeOptions', issues)
  if (forwardClaudeOptions === false) {
    issues.push('permissions.forwardClaudeOptions must be true: Claude\'s option set is forwarded unchanged (design decision B5)')
  }

  const auditRaw = section(raw.audit, ['dir', 'retainDays'], 'audit', issues)
  const auditConfig = {
    dir: pathField(auditRaw.dir, join(dataDir, 'audit'), 'audit.dir', env, issues),
    retainDays: numberField(auditRaw.retainDays, 30, 'audit.retainDays', issues, 1),
  }
  const logsRaw = section(raw.logs, ['dir', 'maxBytes', 'files'], 'logs', issues)
  const logsConfig = {
    dir: pathField(logsRaw.dir, join(dataDir, 'logs'), 'logs.dir', env, issues),
    maxBytes: numberField(logsRaw.maxBytes, 10 * 1024 * 1024, 'logs.maxBytes', issues, 4096),
    files: numberField(logsRaw.files, 3, 'logs.files', issues, 1),
  }
  if (logsConfig.files > 10) issues.push('logs.files must be 10 or fewer')

  const nativeRaw = section(raw.native, ['provider', 'model', 'permissionPreset', 'attachToWorkspace'], 'native', issues)
  const nativeConfig = {
    provider: stringField(nativeRaw.provider, 'acp-claude-code', 'native.provider', issues),
    model: stringField(nativeRaw.model, 'default', 'native.model', issues),
    permissionPreset: stringField(nativeRaw.permissionPreset, 'danger-full-access', 'native.permissionPreset', issues),
    attachToWorkspace: booleanField(nativeRaw.attachToWorkspace, true, 'native.attachToWorkspace', issues),
  }

  if (issues.length > 0) throw new CcwConfigError(issues)

  return {
    dataDir,
    hosts,
    defaultHost,
    workspaces: {
      baseDir: pathField(ws.baseDir, join(dataDir, 'workspaces'), 'workspaces.baseDir', env, []),
      strategy,
      prefix,
    },
    acp: acpConfig,
    events,
    approvals: approvalsConfig,
    permissions: {
      forwardClaudeOptions: true,
      widen: {
        enabled: booleanField(widenRaw.enabled, true, 'permissions.widen.enabled', issues),
        defaultScope: enumField(widenRaw.defaultScope, 'command', WIDEN_SCOPES, 'permissions.widen.defaultScope', issues),
      },
      persist: {
        target: enumField(persistRaw.target, 'project', ['project', 'user'] as const, 'permissions.persist.target', issues),
        confirmUserScope: booleanField(persistRaw.confirmUserScope, true, 'permissions.persist.confirmUserScope', issues),
      },
    },
    audit: auditConfig,
    logs: logsConfig,
    ssh: sshConfig,
    native: nativeConfig,
  }
}

/** Expands `~` and `${DSH_HOME}` in a path and makes it absolute. */
export function expandPath(value: string, env: NodeJS.ProcessEnv): string {
  const home = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  const expanded = value.replaceAll('${DSH_HOME}', home).replace(/^~(?=$|[\\/])/, homedir())
  return resolve(expanded)
}

function resolveHost(
  id: string,
  value: unknown,
  defaultExecutable: string,
  defaultConnectTimeoutMs: number,
  issues: string[],
): HostConfig | null {
  if (!isRecord(value)) {
    issues.push(`hosts.${id} must be an object`)
    return null
  }
  rejectUnknownKeys(value, ['kind', 'alias', 'executable', 'args', 'command', 'env', 'connectTimeoutMs'], `hosts.${id}`, issues)
  const kind = value.kind === undefined ? 'local' : value.kind
  if (kind !== 'local' && kind !== 'ssh') {
    issues.push(`hosts.${id}.kind must be "local" or "ssh"`)
    return null
  }
  const alias = optionalString(value.alias, `hosts.${id}.alias`, issues)
  if (kind === 'local' && alias !== undefined) {
    issues.push(`hosts.${id}.alias is only valid for ssh hosts`)
  }
  const args = value.args === undefined ? [] : Array.isArray(value.args) && value.args.every((entry) => typeof entry === 'string') ? value.args : (issues.push(`hosts.${id}.args must be an array of strings`), [])
  const command = optionalString(value.command, `hosts.${id}.command`, issues)
  if (command !== undefined && args.length > 0) {
    issues.push(`hosts.${id}: command and args cannot both be set; command replaces the executable and its arguments`)
  }
  const hostEnv = value.env === undefined ? {} : isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === 'string') ? value.env as Record<string, string> : (issues.push(`hosts.${id}.env must map strings to strings`), {})
  return {
    kind,
    ...(kind === 'ssh' ? { alias: alias ?? id } : {}),
    executable: stringField(value.executable, defaultExecutable, `hosts.${id}.executable`, issues),
    args,
    ...(command === undefined ? {} : { command }),
    env: hostEnv,
    connectTimeoutMs: numberField(value.connectTimeoutMs, defaultConnectTimeoutMs, `hosts.${id}.connectTimeoutMs`, issues, 1),
  }
}

function section(value: unknown, allowed: readonly string[], name: string, issues: string[]): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    issues.push(`${name} must be an object`)
    return {}
  }
  rejectUnknownKeys(value, allowed, name, issues)
  return value
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${name}.${key} is not a recognized option`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, name: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${name} must be a non-empty string`)
    return undefined
  }
  return value
}

function stringField(value: unknown, fallback: string, name: string, issues: string[]): string {
  return optionalString(value, name, issues) ?? fallback
}

function numberField(value: unknown, fallback: number, name: string, issues: string[], minimum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    issues.push(`${name} must be a finite number >= ${minimum}`)
    return fallback
  }
  return value
}

function booleanField(value: unknown, fallback: boolean, name: string, issues: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push(`${name} must be a boolean`)
    return fallback
  }
  return value
}

function enumField<T extends string>(value: unknown, fallback: T, allowed: readonly T[], name: string, issues: string[]): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(`${name} must be one of ${allowed.join(', ')}`)
    return fallback
  }
  return value as T
}

function pathField(value: unknown, fallback: string, name: string, env: NodeJS.ProcessEnv, issues: string[]): string {
  const raw = optionalString(value, name, issues) ?? fallback
  const expanded = expandPath(raw, env)
  if (!isAbsolute(expanded)) {
    issues.push(`${name} must resolve to an absolute path`)
    return expanded
  }
  return expanded
}

function versionField(value: unknown, fallback: string, name: string, issues: string[]): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    issues.push(`${name} must be a semantic version such as 0.99.0`)
    return fallback
  }
  return value
}

/**
 * Compares two plain semantic versions by numeric release components.
 *
 * @param left - Version such as `0.99.1`.
 * @param right - Version such as `1.0.0`.
 * @returns Negative, zero, or positive following `Array.prototype.sort` order.
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10))
  const b = right.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
