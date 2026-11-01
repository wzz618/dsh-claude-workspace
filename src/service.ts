import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, posix } from 'node:path'
import type {
  LoadSessionResult,
  PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
} from './acp/types.ts'
import { AcpClient } from './acp/client.ts'
import { SessionTranslator, type CcwEvent } from './acp/mapping.ts'
import { AcpPool, type WorkspaceRuntimeState } from './acp/pool.ts'
import { AuditLog, hashArgs } from './audit.ts'
import { resolveConfig, type CcwConfigInput, type ResolvedConfig, type WidenScope, compareVersions } from './config.ts'
import { PermissionGate, type PendingPermission } from './gate/permission.ts'
import { PlanGate, type PlanDecision, type PlanSnapshot } from './gate/plan.ts'
import { SettingsWriter, settingsTargetPath } from './gate/settings-writer.ts'
import { findAllowOnce, findAllowWithUpdates, findReject, isHighRiskCommand, normalizeOptionKind } from './gate/options.ts'
import { buildWidenRules, describeTool, matchesWidenedRule } from './gate/widen.ts'
import { createHostOps } from './host/index.ts'
import type { DirectoryEntry, HostOps } from './host/types.ts'
import { CcwError, tail } from './util/errors.ts'
import {
  createWorkspace,
  deleteWorkspaceDirectory,
  deriveSessionDirectory,
  ensureSessionDirectory,
  isSubpath,
  removeWorkspace,
  renameWorkspace,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
} from './workspace/lifecycle.ts'
import { DshWorkspaceRegistry, UnregisteredWorkspaceRegistry, type WorkspaceControllerLike, type WorkspaceRegistry } from './workspace/registry.ts'
import { SessionStore, WorkspaceStore } from './workspace/store.ts'
import type { CcwSessionBinding, CcwWorkspace } from './workspace/types.ts'

/** Events delivered to a connected client surface. */
export type CcwHostEvent =
  | { readonly type: 'session'; readonly dshSessionId: string; readonly seq: number; readonly event: CcwEvent }
  | { readonly type: 'approvals'; readonly dshSessionId?: string }
  | { readonly type: 'plan'; readonly dshSessionId: string; readonly plan: PlanSnapshot }
  | { readonly type: 'runtime'; readonly workspaceId: string; readonly state: WorkspaceRuntimeState }

export interface CcwServiceOptions {
  readonly config: CcwConfigInput
  /** DSH workspace controller when composed. */
  readonly workspaceController?: WorkspaceControllerLike
  readonly registry?: WorkspaceRegistry
  readonly hostFactory?: (id: string) => HostOps
  readonly now?: () => number
  readonly newId?: () => string
  /** Home directory used for user-scope settings on local hosts. */
  readonly home?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface OpenSessionInput {
  readonly workspaceId: string
  readonly dshSessionId: string
  readonly model?: string
  readonly effort?: string
  readonly mode?: string
}

export interface OpenSessionResult {
  readonly binding: CcwSessionBinding
  readonly resumed: boolean
  readonly modes?: SessionModeState
  readonly configOptions: readonly SessionConfigOption[]
}

export interface PromptInput {
  readonly dshSessionId: string
  readonly text: string
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[]
}

export interface PromptOutcome {
  readonly stopReason: StopReason
  readonly usage?: Record<string, number>
  readonly cancelled: boolean
}

export interface WidenPreview {
  readonly requestId: string
  readonly rules: readonly string[]
  readonly file: string
  readonly notes: readonly string[]
  readonly highRisk: boolean
  readonly requiresConfirmation: boolean
}

export interface WidenInput {
  readonly requestId: string
  readonly scope: WidenScope
  readonly customRule?: string
  readonly target?: 'project' | 'user'
  readonly confirmed?: boolean
}

export interface HealthReport {
  readonly ok: boolean
  readonly executable?: string
  readonly version?: string
  readonly versionSupported?: boolean
  readonly handshake?: boolean
  readonly session?: boolean
  readonly error?: string
  readonly nextAction?: string
}

export interface ReattachResult {
  readonly binding?: CcwSessionBinding
  readonly state: WorkspaceRuntimeState
  readonly running: boolean
  readonly pending: readonly PendingPermission[]
  readonly events: readonly { readonly seq: number; readonly event: CcwEvent }[]
}

interface RunningState {
  running: boolean
  startedAt?: number
}

/**
 * Host-side façade over workspaces, sessions, permissions, and the ACP pool.
 *
 * The service is transport-agnostic: the DSH plugin exposes it over a loopback
 * HTTP API, and tests call it directly. Every user-visible decision is audited
 * with metadata only.
 */
export class CcwService {
  readonly #config: ResolvedConfig
  readonly #workspaces: WorkspaceStore
  readonly #sessions: SessionStore
  #registry: WorkspaceRegistry
  readonly #hosts = new Map<string, HostOps>()
  readonly #hostFactory: ((id: string) => HostOps) | undefined
  readonly #pool: AcpPool
  readonly #gate: PermissionGate
  readonly #plans: PlanGate
  readonly #audit: AuditLog
  readonly #auditReady: Promise<unknown>
  readonly #settings: SettingsWriter
  readonly #home: string
  readonly #now: () => number
  readonly #newId: () => string
  readonly #translators = new Map<string, SessionTranslator>()
  readonly #translatorAcp = new Map<string, string>()
  readonly #sequences = new Map<string, number>()
  readonly #buffers = new Map<string, { seq: number; event: CcwEvent }[]>()
  readonly #acpToDsh = new Map<string, string>()
  readonly #replaying = new Set<string>()
  readonly #running = new Map<string, RunningState>()
  readonly #sessionRules = new Map<string, string[]>()
  readonly #sessionOptions = new Map<string, { modes?: SessionModeState; configOptions: readonly SessionConfigOption[] }>()
  readonly #listeners = new Set<(event: CcwHostEvent) => void>()
  #closed = false

  constructor(options: CcwServiceOptions) {
    this.#config = resolveConfig(options.config, options.env)
    this.#now = options.now ?? Date.now
    this.#newId = options.newId ?? (() => `ws_${randomUUID().replaceAll('-', '').slice(0, 12)}`)
    this.#home = options.home ?? homedir()
    this.#workspaces = new WorkspaceStore(this.#config.dataDir)
    this.#sessions = new SessionStore(this.#config.dataDir)
    this.#registry = options.registry
      ?? (options.workspaceController === undefined
        ? new UnregisteredWorkspaceRegistry()
        : new DshWorkspaceRegistry(options.workspaceController))
    this.#hostFactory = options.hostFactory
    this.#audit = new AuditLog(this.#config.audit.dir, { retainDays: this.#config.audit.retainDays, now: () => new Date(this.#now()) })
    // Enforce the retention window once per service start; a failure must not
    // prevent the plugin from loading.
    this.#auditReady = this.#audit.prune().catch(() => undefined)
    this.#settings = new SettingsWriter(this.#config.dataDir)
    this.#gate = new PermissionGate({
      timeoutMs: this.#config.approvals.timeoutMs,
      now: this.#now,
      onChange: () => this.#emit({ type: 'approvals' }),
    })
    this.#plans = new PlanGate({
      now: this.#now,
      onChange: (plans) => {
        for (const plan of plans) this.#emit({ type: 'plan', dshSessionId: plan.sessionId, plan })
      },
    })
    this.#pool = new AcpPool((hostId) => this.#host(hostId), {
      maxLineBytes: this.#config.acp.maxLineBytes,
      handshakeTimeoutMs: this.#config.acp.handshakeTimeoutMs,
      requestTimeoutMs: this.#config.acp.requestTimeoutMs,
      promptTimeoutMs: this.#config.acp.promptTimeoutMs,
      idleRecycleMs: this.#config.acp.idleRecycleMs,
      log: this.#config.logs,
      onSessionUpdate: (workspaceId, sessionId, update) => this.#onSessionUpdate(workspaceId, sessionId, update),
      onPermission: (workspaceId, params) => this.#onPermission(workspaceId, params),
      onDisconnect: (workspaceId) => {
        this.#emit({ type: 'runtime', workspaceId, state: 'disconnected' })
        this.#gate.expireAll('connection closed', { workspaceId })
      },
      onIdleClose: (workspaceId) => this.#emit({ type: 'runtime', workspaceId, state: 'stopped' }),
    })
  }

  /** Resolved configuration, for diagnostics. */
  get config(): ResolvedConfig {
    return this.#config
  }

  /** True when DSH's workspace registry is available. */
  get registryAvailable(): boolean {
    return this.#registry.available
  }

  /**
   * Attaches DSH's workspace controller once the service appears.
   *
   * The controller usually loads after this plugin, so `apply` cannot read it
   * at construction. Active workspaces created while only the plugin registry
   * existed are registered now; a failure leaves that workspace unregistered
   * and reports through its record rather than dropping it.
   *
   * @param controller - `ctx.workspaceController` surface.
   */
  async attachWorkspaceController(controller: WorkspaceControllerLike): Promise<void> {
    if (this.#registry.available) return
    this.#registry = new DshWorkspaceRegistry(controller)
    for (const workspace of await this.#workspaces.listActive()) {
      if (workspace.dshWorkspaceId !== undefined) continue
      try {
        const registration = await this.#registry.register({ path: workspace.dir, title: workspace.title })
        if (registration !== undefined) {
          await this.#workspaces.update(workspace.id, { dshWorkspaceId: registration.id })
        }
      } catch {
        // Keep the directory and record; a later create/add retries registration.
      }
    }
  }

  /** Subscribes to Host events; returns an unsubscribe function. */
  onEvent(listener: (event: CcwHostEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Host entries with the default marked. */
  listHosts(): { id: string; kind: 'local' | 'ssh'; alias?: string; default: boolean }[] {
    return Object.entries(this.#config.hosts).map(([id, host]) => ({
      id,
      kind: host.kind,
      ...(host.kind === 'ssh' ? { alias: host.alias ?? id } : {}),
      default: id === this.#config.defaultHost,
    }))
  }

  /** Checks executable, version, handshake, and optionally session creation. */
  async healthCheck(hostId: string, options: { cwd?: string } = {}): Promise<HealthReport> {
    const hostConfig = this.#config.hosts[hostId]
    if (hostConfig === undefined) {
      throw new CcwError('config-invalid', `host "${hostId}" is not configured`, { hostId })
    }
    const host = this.#host(hostId)
    const probe = await host.probe(hostConfig.executable)
    if (!probe.found) {
      return {
        ok: false,
        executable: hostConfig.executable,
        error: `${hostConfig.executable} was not found on ${hostConfig.kind === 'ssh' ? `host "${hostId}"` : 'this host'}`,
        nextAction: hostConfig.kind === 'ssh'
          ? `install claude-agent-acp on ${hostId} and make sure it is on the non-interactive PATH`
          : 'install @agentclientprotocol/claude-agent-acp and make sure it is on PATH',
      }
    }
    const versionSupported = probe.version === undefined
      ? undefined
      : compareVersions(probe.version, this.#config.acp.minimumVersion) >= 0
        && compareVersions(probe.version, this.#config.acp.maximumVersionExclusive) < 0
    let handshake = false
    let session: boolean | undefined
    let error: string | undefined
    if (options.cwd !== undefined) {
      let client: AcpClient | undefined
      try {
        client = await AcpClient.start(host, {
          maxLineBytes: this.#config.acp.maxLineBytes,
          handshakeTimeoutMs: this.#config.acp.handshakeTimeoutMs,
          requestTimeoutMs: this.#config.acp.requestTimeoutMs,
          promptTimeoutMs: this.#config.acp.promptTimeoutMs,
          onSessionUpdate: () => undefined,
          onPermission: async () => ({ outcome: 'cancelled' }),
          onClose: () => undefined,
        }, options.cwd)
        handshake = true
        await client.newSession({ cwd: options.cwd, mcpServers: [] })
        session = true
      } catch (failure) {
        error = tail(messageOf(failure))
        session = false
      } finally {
        await client?.stop().catch(() => undefined)
      }
    }
    return {
      ok: session ?? (versionSupported !== false),
      executable: probe.path,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      ...(versionSupported === undefined ? {} : { versionSupported }),
      handshake,
      ...(session === undefined ? {} : { session }),
      ...(error === undefined ? {} : { error }),
      ...(versionSupported === false
        ? { nextAction: `use claude-agent-acp ${this.#config.acp.minimumVersion} or newer (below ${this.#config.acp.maximumVersionExclusive})` }
        : {}),
    }
  }

  /** Creates or resolves a workspace. */
  async createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const result = await createWorkspace(
      {
        config: this.#config,
        workspaces: this.#workspaces,
        registry: this.#registry,
        host: (id) => this.#host(id),
        closeHost: (hostId) => void this.#pool.closeHost(hostId),
        now: this.#now,
        newId: this.#newId,
      },
      input,
    )
    return result
  }

  /** Every workspace, newest activity first. */
  async listWorkspaces(): Promise<CcwWorkspace[]> {
    const workspaces = await this.#workspaces.list()
    return workspaces.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  }

  /** Renames one workspace. */
  async renameWorkspace(workspaceId: string, title: string): Promise<CcwWorkspace> {
    return renameWorkspace({ workspaces: this.#workspaces, registry: this.#registry }, workspaceId, title)
  }

  /** Removes a workspace from DSH but keeps its directory. */
  async removeWorkspace(workspaceId: string): Promise<CcwWorkspace> {
    await this.#requireWorkspace(workspaceId)
    await this.#pool.close(workspaceId, 'requested')
    return removeWorkspace(
      {
        config: this.#config,
        workspaces: this.#workspaces,
        registry: this.#registry,
        host: (id) => this.#host(id),
      },
      workspaceId,
    )
  }

  /** Deletes a removed, derived workspace directory after explicit confirmation. */
  async deleteWorkspaceDirectory(workspaceId: string, confirmation: { deleteDirectory?: boolean }): Promise<void> {
    await deleteWorkspaceDirectory(
      { config: this.#config, workspaces: this.#workspaces, host: (id) => this.#host(id) },
      workspaceId,
      confirmation,
    )
  }

  /** Opens or resumes the ACP session bound to a DSH session. */
  async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    const workspace = await this.#requireWorkspace(input.workspaceId)
    const existing = await this.#sessions.get(input.dshSessionId)
    const createdAt = existing?.createdAt ?? this.#now()
    const cwd = existing?.cwd ?? deriveSessionDirectory({ config: this.#config }, workspace, {
      dshSessionId: input.dshSessionId,
      createdAt,
    })
    await ensureSessionDirectory(this.#host(workspace.hostId), workspace, cwd)
    const client = await this.#pool.acquire(workspace.id, workspace.hostId, workspace.dir)
    try {
      if (existing !== undefined && existing.acpSessionId !== undefined) {
        this.#remember(existing, input.dshSessionId)
        if (!client.hasSession(existing.acpSessionId)) {
          await this.#load(client, existing)
        }
        const updated = await this.#applyOptions(existing, input)
        const cached = this.#sessionOptions.get(input.dshSessionId)
        return {
          binding: updated,
          resumed: true,
          ...(cached?.modes === undefined ? {} : { modes: cached.modes }),
          configOptions: cached?.configOptions ?? [],
        }
      }
      const created = await client.newSession({ cwd, mcpServers: [] })
      const binding: CcwSessionBinding = {
        dshSessionId: input.dshSessionId,
        workspaceId: workspace.id,
        acpSessionId: created.sessionId,
        cwd,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        createdAt,
        lastEventSeq: 0,
        needsLoad: false,
      }
      await this.#sessions.upsert(binding)
      this.#remember(binding, input.dshSessionId)
      this.#ensureTranslator(input.dshSessionId, created.sessionId, 0)
      this.#sessionOptions.set(input.dshSessionId, {
        ...(created.modes === undefined ? {} : { modes: created.modes }),
        configOptions: created.configOptions ?? [],
      })
      if (input.model !== undefined) await this.#setConfig(client, created.sessionId, 'model', input.model)
      if (input.effort !== undefined) await this.#setConfig(client, created.sessionId, 'effort', input.effort)
      if (input.mode !== undefined) await this.#setConfig(client, created.sessionId, 'mode', input.mode)
      await this.#touchWorkspace(workspace.id)
      return {
        binding,
        resumed: false,
        ...(created.modes === undefined ? {} : { modes: created.modes }),
        configOptions: created.configOptions ?? [],
      }    } catch (error) {
      if (error instanceof CcwError) throw error
      throw new CcwError(
        'session-open-failed',
        `could not open a Claude Code session in ${cwd}: ${messageOf(error)}`,
        { workspaceId: workspace.id, cwd },
        { cause: error },
      )
    } finally {
      this.#pool.release(workspace.id)
    }
  }

  /** Sends one prompt and waits for the turn to finish. */
  async prompt(input: PromptInput): Promise<PromptOutcome> {
    const binding = await this.#requireBinding(input.dshSessionId)
    const workspace = await this.#requireWorkspace(binding.workspaceId)
    if (binding.acpSessionId === undefined) {
      throw new CcwError('session-not-found', 'session has no ACP id; open it again', { sessionId: input.dshSessionId })
    }
    const running = this.#runningOf(input.dshSessionId)
    if (running.running) {
      throw new CcwError(
        'turn-already-running',
        'a turn is already running in this session; stop it before sending another prompt',
        { sessionId: input.dshSessionId },
      )
    }
    running.running = true
    running.startedAt = this.#now()
    this.#emit({ type: 'runtime', workspaceId: workspace.id, state: 'busy' })
    try {
      const client = await this.#pool.acquire(workspace.id, workspace.hostId, workspace.dir)
      try {
        if (!client.hasSession(binding.acpSessionId)) await this.#load(client, binding)
        const prompt: Parameters<AcpClient['prompt']>[0]['prompt'] = [
          { type: 'text', text: input.text },
          ...(input.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
        ]
        const result: PromptResult = await client.prompt({ sessionId: binding.acpSessionId, prompt })
        const cancelled = result.stopReason === 'cancelled'
        if (cancelled) this.#emitTranslator(this.#translatorFor(input.dshSessionId).markCancelled(), input.dshSessionId)
        const seq = this.#sequences.get(input.dshSessionId) ?? binding.lastEventSeq
        await this.#sessions.update(input.dshSessionId, {
          lastTurnAt: this.#now(),
          lastEventSeq: seq,
          needsLoad: false,
          ...(binding.model === undefined ? {} : { model: binding.model }),
        })
        await this.#auditDecision({
          workspace,
          dshSessionId: input.dshSessionId,
          kind: 'session',
          decision: result.stopReason,
          latencyMs: this.#now() - (running.startedAt ?? this.#now()),
        })
        return {
          stopReason: result.stopReason,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          cancelled,
        }
      } finally {
        this.#pool.release(workspace.id)
      }
    } finally {
      running.running = false
      running.startedAt = undefined
      this.#emit({ type: 'runtime', workspaceId: workspace.id, state: this.#pool.state(workspace.id) })
    }
  }

  /** Requests cancellation of the current turn. */
  async cancelSession(dshSessionId: string): Promise<void> {
    const binding = await this.#requireBinding(dshSessionId)
    const workspace = await this.#requireWorkspace(binding.workspaceId)
    if (binding.acpSessionId === undefined) return
    const client = this.#pool.client(workspace.id)
    if (client === undefined) {
      throw new CcwError('acp-disconnected', 'the Claude Code process is not running; the turn already stopped', {
        workspaceId: workspace.id,
      })
    }
    client.cancel(binding.acpSessionId)
    this.#emitTranslator(this.#translatorFor(dshSessionId).markCancelled(), dshSessionId)
    await this.#auditDecision({ workspace, dshSessionId, kind: 'session', decision: 'cancel-requested' })
  }

  /**
   * Restarts the workspace process and reloads the bound ACP session.
   *
   * Reconnection never replays an unconfirmed prompt: it only rebuilds the
   * transport and calls `session/load`, matching the ACP ambiguity rule.
   *
   * @param dshSessionId - DSH session to reconnect.
   * @returns The reopened session state.
   */
  async reconnectSession(dshSessionId: string): Promise<OpenSessionResult> {
    const binding = await this.#requireBinding(dshSessionId)
    const workspace = await this.#requireWorkspace(binding.workspaceId)
    await this.#pool.close(workspace.id, 'requested')
    return this.openSession({ workspaceId: workspace.id, dshSessionId })
  }

  /** Answers a pending permission request with one of Claude's own option ids. */
  async answerPermission(requestId: string, optionId: string): Promise<void> {
    const record = this.#gate.get(requestId)
    this.#gate.answer(requestId, optionId)
    const option = record?.options.find((candidate) => candidate.optionId === optionId)
    await this.#auditDecision({
      workspace: record?.workspaceId === undefined ? undefined : await this.#workspaces.get(record.workspaceId),
      dshSessionId: record?.dshSessionId ?? record?.sessionId ?? 'unknown',
      kind: 'permission',
      tool: record?.toolCall.name ?? record?.toolCall.title,
      argsHash: hashArgs(record?.toolCall.rawInput),
      decision: `${normalizeOptionKind(option?.kind ?? 'unknown')}:${optionId}`,
      latencyMs: record === undefined ? undefined : this.#now() - record.createdAt,
    })
  }

  /** Pending permission requests, optionally limited to one DSH session. */
  pendingApprovals(dshSessionId?: string): PendingPermission[] {
    return this.#gate.pending().filter(
      (record) => dshSessionId === undefined || record.dshSessionId === dshSessionId || record.sessionId === dshSessionId,
    )
  }

  /** Calculates the rule and file a widen choice would use, without writing. */
  async previewWiden(
    requestId: string,
    scope: WidenScope,
    customRule?: string,
    target: 'project' | 'user' = this.#config.permissions.persist.target,
  ): Promise<WidenPreview> {
    const record = this.#gate.get(requestId)
    if (record === undefined || record.status !== 'pending') {
      throw new CcwError('permission-unknown-request', `permission request ${requestId} is not pending`, { requestId })
    }
    const binding = record.dshSessionId === undefined ? undefined : await this.#sessions.get(record.dshSessionId)
    const workspace = record.workspaceId === undefined ? undefined : await this.#workspaces.get(record.workspaceId)
    if (binding === undefined || workspace === undefined) {
      throw new CcwError('permission-unknown-request', 'the request is not attached to a known session', { requestId })
    }
    const host = this.#host(workspace.hostId)
    const rules = buildWidenRules(record.toolCall, binding.cwd, scope, customRule)
    const home = target === 'user' ? await host.home() : this.#home
    const file = settingsTargetPath(binding.cwd, target, home)
    const highRisk = isHighRiskCommand(describeTool(record.toolCall).command)
    return {
      requestId,
      rules: rules.rules,
      file,
      notes: rules.notes,
      highRisk,
      requiresConfirmation: highRisk || (target === 'user' && this.#config.permissions.persist.confirmUserScope),
    }
  }

  /**
   * Applies a widen choice.
   *
   * `command` forwards Claude's own `allow-with-updates` option; `prefix` and
   * `tool` write a CCW rule, remember it for the rest of this session, and
   * answer with `allow-once`.
   */
  async widenPermission(input: WidenInput): Promise<{ rules: readonly string[]; file?: string; forwarded: boolean }> {
    const record = this.#gate.get(input.requestId)
    if (record === undefined || record.status !== 'pending') {
      throw new CcwError('permission-unknown-request', `permission request ${input.requestId} is not pending`, {
        requestId: input.requestId,
      })
    }
    const target = input.target ?? this.#config.permissions.persist.target
    const preview = await this.previewWiden(input.requestId, input.scope, input.customRule, target)
    const workspace = record.workspaceId === undefined ? undefined : await this.#workspaces.get(record.workspaceId)
    if (workspace === undefined) {
      throw new CcwError('permission-unknown-request', 'the request is not attached to a known workspace', {
        requestId: input.requestId,
      })
    }
    const host = this.#host(workspace.hostId)
    if (preview.requiresConfirmation && input.confirmed !== true) {
      throw new CcwError(
        'confirmation-required',
        preview.highRisk
          ? 'this command looks destructive; confirm the rule and target file before saving'
          : 'writing a user-level rule requires explicit confirmation',
        { requestId: input.requestId, file: preview.file, rules: preview.rules },
      )
    }
    if (input.scope === 'command') {
      const option = findAllowWithUpdates(record.options) ?? findAllowOnce(record.options)
      if (option === undefined) {
        throw new CcwError('widen-unsupported', 'Claude did not offer an allow option for this request', {
          requestId: input.requestId,
        })
      }
      this.#gate.answer(input.requestId, option.optionId)
      await this.#auditDecision({
        workspace,
        dshSessionId: record.dshSessionId ?? record.sessionId,
        kind: 'widen',
        tool: record.toolCall.name ?? record.toolCall.title,
        argsHash: hashArgs(record.toolCall.rawInput),
        decision: `forwarded:${normalizeOptionKind(option.kind)}`,
      })
      return { rules: [], forwarded: true }
    }
    const allowOnce = findAllowOnce(record.options) ?? record.options.find((option) => normalizeOptionKind(option.kind).startsWith('allow'))
    if (allowOnce === undefined) {
      throw new CcwError('widen-unsupported', 'Claude did not offer a one-time allow option', { requestId: input.requestId })
    }
    await this.#settings.ensureAllowed(host, preview.file, preview.rules, {
      host: workspace.hostId,
      ...(toolNameOf(record.toolCall) === undefined ? {} : { tool: toolNameOf(record.toolCall)! }),
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      ...(record.dshSessionId === undefined ? {} : { sessionId: record.dshSessionId }),
      requestId: record.requestId,
    })
    if (record.dshSessionId !== undefined) {
      const rules = this.#sessionRules.get(record.dshSessionId) ?? []
      this.#sessionRules.set(record.dshSessionId, [...new Set([...rules, ...preview.rules])])
    }
    this.#gate.answer(input.requestId, allowOnce.optionId)
    await this.#auditDecision({
      workspace,
      dshSessionId: record.dshSessionId ?? record.sessionId,
      kind: 'widen',
      tool: record.toolCall.name ?? record.toolCall.title,
      argsHash: hashArgs(record.toolCall.rawInput),
      decision: `rules:${preview.rules.join('|')}`,
    })
    return { rules: preview.rules, file: preview.file, forwarded: false }
  }

  /** Rules CCW wrote and can revoke. */
  async writtenRules(): Promise<Awaited<ReturnType<SettingsWriter['listWrittenRules']>>> {
    return this.#settings.listWrittenRules()
  }

  /** Removes one CCW-written rule from the host that owns it. */
  async revokeRule(id: string): Promise<Awaited<ReturnType<SettingsWriter['revoke']>>> {
    const entry = (await this.#settings.listWrittenRules()).find((rule) => rule.id === id)
    if (entry === undefined) {
      throw new CcwError('settings-invalid', `no CCW-written rule with id ${id}`, { id })
    }
    return this.#settings.revoke(this.#host(entry.host), id)
  }

  /** Changes model, effort, or mode for one session. */
  async setOption(dshSessionId: string, configId: string, value: string | boolean): Promise<CcwSessionBinding> {
    const binding = await this.#requireBinding(dshSessionId)
    if (binding.acpSessionId === undefined) {
      throw new CcwError('session-not-found', 'session has no ACP id; open it again', { sessionId: dshSessionId })
    }
    const workspace = await this.#requireWorkspace(binding.workspaceId)
    const client = await this.#pool.acquire(workspace.id, workspace.hostId, workspace.dir)
    try {
      if (!client.hasSession(binding.acpSessionId)) await this.#load(client, binding)
      await this.#setConfig(client, binding.acpSessionId, configId, value)
    } finally {
      this.#pool.release(workspace.id)
    }
    const patch: Partial<CcwSessionBinding> = {}
    if (configId === 'model' && typeof value === 'string') patch.model = value
    if (configId === 'effort' && typeof value === 'string') patch.effort = value
    if (configId === 'mode' && typeof value === 'string') patch.mode = value
    const cached = this.#sessionOptions.get(dshSessionId)
    if (cached !== undefined) {
      this.#sessionOptions.set(dshSessionId, {
        ...cached,
        configOptions: cached.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option),
      })
    }
    if (Object.keys(patch).length === 0) return binding
    return this.#sessions.update(dshSessionId, patch)
  }

  /** Latest config options and modes reported by the agent for one session. */
  sessionOptions(
    dshSessionId: string,
  ): { readonly modes?: SessionModeState; readonly configOptions: readonly SessionConfigOption[] } | undefined {
    return this.#sessionOptions.get(dshSessionId)
  }

  /** Latest plan for one session. */
  plan(dshSessionId: string): PlanSnapshot | undefined {
    return this.#plans.get(dshSessionId)
  }

  /** Records a plan decision and turns it into a prompt or a cancellation. */
  async decidePlan(dshSessionId: string, decision: PlanDecision): Promise<PlanSnapshot> {
    const snapshot = this.#plans.decide(dshSessionId, decision)
    const binding = await this.#requireBinding(dshSessionId)
    const workspace = await this.#requireWorkspace(binding.workspaceId)
    await this.#auditDecision({
      workspace,
      dshSessionId,
      kind: 'plan',
      decision: decision.kind,
    })
    if (decision.kind === 'cancel') {
      await this.cancelSession(dshSessionId)
    } else {
      const feedback = decision.feedback?.trim()
      if (feedback !== undefined && feedback.length > 0) {
        void this.prompt({ dshSessionId, text: feedback }).catch(() => undefined)
      }
    }
    return snapshot
  }

  /** Restores pending approvals and buffered events after a page refresh. */
  async reattach(dshSessionId: string, sinceSeq?: number): Promise<ReattachResult> {
    const binding = await this.#sessions.get(dshSessionId)
    const buffer = this.#buffers.get(dshSessionId) ?? []
    const events = sinceSeq === undefined ? buffer : buffer.filter((entry) => entry.seq > sinceSeq)
    const workspaceId = binding?.workspaceId
    return {
      ...(binding === undefined ? {} : { binding }),
      state: workspaceId === undefined ? 'stopped' : this.#pool.state(workspaceId),
      running: this.#runningOf(dshSessionId).running,
      pending: this.pendingApprovals(dshSessionId),
      events,
    }
  }

  /** Every persisted session binding. */
  async listSessions(): Promise<CcwSessionBinding[]> {
    return this.#sessions.list()
  }

  /**
   * Lists one directory inside a workspace for the `@` file picker.
   *
   * The directory is constrained to the workspace root or one of its derived
   * session directories; a caller cannot turn this into arbitrary host listing.
   *
   * @param workspaceId - Workspace to browse.
   * @param options - Starting directory and, when omitted, the session whose cwd is used.
   * @returns The listed directory and its direct children.
   */
  async listWorkspaceDirectory(
    workspaceId: string,
    options: { readonly dir?: string; readonly dshSessionId?: string } = {},
  ): Promise<{ readonly dir: string; readonly entries: readonly DirectoryEntry[] }> {
    const workspace = await this.#requireWorkspace(workspaceId)
    const binding = options.dshSessionId === undefined ? undefined : await this.#sessions.get(options.dshSessionId)
    const root = binding?.cwd ?? workspace.dir
    const target = options.dir === undefined ? root : options.dir
    if (!isAbsolute(target)) {
      throw new CcwError('dir-not-found', `directory must be absolute: ${target}`, { dir: target })
    }
    const normalized = posix.normalize(target)
    const roots = binding === undefined ? [workspace.dir] : [workspace.dir, binding.cwd]
    if (!roots.some((root) => isSubpath(root, normalized))) {
      throw new CcwError('dir-not-found', `directory is outside workspace ${workspace.id}: ${normalized}`, {
        dir: normalized,
        workspaceId: workspace.id,
      })
    }
    const host = this.#host(workspace.hostId)
    return { dir: normalized, entries: await host.listDirectory(normalized, 500) }
  }

  /** Reads one day's audit entries. */
  async auditEntries(day: string): Promise<Awaited<ReturnType<AuditLog['list']>>> {
    return this.#audit.list(day)
  }

  /** Stops processes and releases pending requests. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#persistSequences()
    this.#gate.dispose()
    await this.#pool.closeAll()
    this.#listeners.clear()
  }

  // ── internals ──────────────────────────────────────────────────────────

  #host(hostId: string): HostOps {
    const cached = this.#hosts.get(hostId)
    if (cached !== undefined) return cached
    const config = this.#config.hosts[hostId]
    if (config === undefined) throw new CcwError('config-invalid', `host "${hostId}" is not configured`, { hostId })
    const created = this.#hostFactory !== undefined ? this.#hostFactory(hostId) : createHostOps(hostId, config, this.#config.ssh)
    this.#hosts.set(hostId, created)
    return created
  }

  async #requireWorkspace(workspaceId: string): Promise<CcwWorkspace> {
    const workspace = await this.#workspaces.get(workspaceId)
    if (workspace === undefined || workspace.state !== 'active') {
      throw new CcwError('workspace-not-found', `workspace ${workspaceId} does not exist`, { workspaceId })
    }
    return workspace
  }

  async #requireBinding(dshSessionId: string): Promise<CcwSessionBinding> {
    const binding = await this.#sessions.get(dshSessionId)
    if (binding === undefined) {
      throw new CcwError('session-not-found', `session ${dshSessionId} is not bound to a Claude Code session`, {
        sessionId: dshSessionId,
      })
    }
    return binding
  }

  async #touchWorkspace(workspaceId: string): Promise<void> {
    await this.#workspaces.update(workspaceId, { lastUsedAt: this.#now() }).catch(() => undefined)
  }

  #runningOf(dshSessionId: string): RunningState {
    const existing = this.#running.get(dshSessionId)
    if (existing !== undefined) return existing
    const created: RunningState = { running: false }
    this.#running.set(dshSessionId, created)
    return created
  }

  #remember(binding: CcwSessionBinding, dshSessionId: string): void {
    if (binding.acpSessionId !== undefined) this.#acpToDsh.set(binding.acpSessionId, dshSessionId)
    this.#ensureTranslator(dshSessionId, binding.acpSessionId ?? `pending:${dshSessionId}`, binding.lastEventSeq)
  }

  #ensureTranslator(dshSessionId: string, acpSessionId: string, lastSeq: number): SessionTranslator {
    const existing = this.#translators.get(dshSessionId)
    if (existing !== undefined && this.#translatorAcp.get(dshSessionId) === acpSessionId) return existing
    this.#acpToDsh.set(acpSessionId, dshSessionId)
    if (!this.#sequences.has(dshSessionId)) this.#sequences.set(dshSessionId, lastSeq)
    this.#translatorAcp.set(dshSessionId, acpSessionId)
    const created = new SessionTranslator(acpSessionId, this.#now)
    this.#translators.set(dshSessionId, created)
    return created
  }

  #translatorFor(dshSessionId: string): SessionTranslator {
    const existing = this.#translators.get(dshSessionId)
    if (existing !== undefined) return existing
    return this.#ensureTranslator(dshSessionId, `pending:${dshSessionId}`, this.#sequences.get(dshSessionId) ?? 0)
  }

  async #load(client: AcpClient, binding: CcwSessionBinding): Promise<void> {
    if (binding.acpSessionId === undefined) {
      throw new CcwError('session-load-failed', 'the binding has no ACP session id', { sessionId: binding.dshSessionId })
    }
    const translator = this.#translatorFor(binding.dshSessionId)
    this.#replaying.add(binding.dshSessionId)
    try {
      const result: LoadSessionResult = await client.loadSession({
        sessionId: binding.acpSessionId,
        cwd: binding.cwd,
        mcpServers: [],
      })
      const previous = this.#sessionOptions.get(binding.dshSessionId)
      const modes = result.modes ?? previous?.modes
      this.#sessionOptions.set(binding.dshSessionId, {
        ...(modes === undefined ? {} : { modes }),
        configOptions: result.configOptions ?? previous?.configOptions ?? [],
      })
      await this.#reapplyOptions(client, binding)
      await this.#sessions.update(binding.dshSessionId, { needsLoad: false })
      void translator
    } catch (error) {
      await this.#sessions.update(binding.dshSessionId, { needsLoad: true }).catch(() => undefined)
      throw new CcwError(
        'session-load-failed',
        `could not reload Claude Code session ${binding.acpSessionId}: ${messageOf(error)}. Start a new session instead.`,
        { sessionId: binding.dshSessionId, acpSessionId: binding.acpSessionId },
        { cause: error },
      )
    } finally {
      this.#replaying.delete(binding.dshSessionId)
    }
  }

  async #reapplyOptions(client: AcpClient, binding: CcwSessionBinding): Promise<void> {
    if (binding.acpSessionId === undefined) return
    if (binding.model !== undefined) await this.#setConfig(client, binding.acpSessionId, 'model', binding.model)
    if (binding.effort !== undefined) await this.#setConfig(client, binding.acpSessionId, 'effort', binding.effort)
    if (binding.mode !== undefined) await this.#setConfig(client, binding.acpSessionId, 'mode', binding.mode)
  }

  async #applyOptions(binding: CcwSessionBinding, input: OpenSessionInput): Promise<CcwSessionBinding> {
    const patch: Partial<CcwSessionBinding> = {}
    if (input.model !== undefined && input.model !== binding.model) patch.model = input.model
    if (input.effort !== undefined && input.effort !== binding.effort) patch.effort = input.effort
    if (input.mode !== undefined && input.mode !== binding.mode) patch.mode = input.mode
    if (Object.keys(patch).length === 0) return binding
    const client = this.#pool.client(binding.workspaceId)
    if (client !== undefined && binding.acpSessionId !== undefined) {
      if (!client.hasSession(binding.acpSessionId)) await this.#load(client, binding)
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'string') await this.#setConfig(client, binding.acpSessionId, key, value)
      }
    }
    return this.#sessions.update(binding.dshSessionId, patch)
  }

  async #setConfig(client: AcpClient, sessionId: string, configId: string, value: string | boolean): Promise<void> {
    try {
      await client.setConfigOption({ sessionId, configId, value })
    } catch (error) {
      throw new CcwError(
        'session-open-failed',
        `Claude Code rejected ${configId}=${String(value)}: ${messageOf(error)}`,
        { configId, value },
        { cause: error },
      )
    }
  }

  #onSessionUpdate(workspaceId: string, acpSessionId: string, update: SessionUpdate): void {
    const dshSessionId = this.#acpToDsh.get(acpSessionId) ?? `acp:${acpSessionId}`
    const translator = this.#translatorFor(dshSessionId)
    const replay = this.#replaying.has(dshSessionId)
    const events = translator.translate(update, { replay })
    this.#emitTranslator(events, dshSessionId)
    if (update.sessionUpdate === 'plan') {
      this.#plans.record(dshSessionId, update.entries ?? [], replay)
    }
    void workspaceId
  }

  #emitTranslator(events: readonly CcwEvent[], dshSessionId: string): void {
    for (const event of events) {
      const seq = (this.#sequences.get(dshSessionId) ?? 0) + 1
      this.#sequences.set(dshSessionId, seq)
      const stamped = { ...event, seq }
      const buffer = this.#buffers.get(dshSessionId) ?? []
      buffer.push({ seq, event: stamped })
      if (buffer.length > this.#config.events.bufferSize) buffer.splice(0, buffer.length - this.#config.events.bufferSize)
      this.#buffers.set(dshSessionId, buffer)
      this.#emit({ type: 'session', dshSessionId, seq, event: stamped })
    }
  }

  async #onPermission(workspaceId: string, params: RequestPermissionParams): Promise<PermissionOutcome> {
    const dshSessionId = this.#acpToDsh.get(params.sessionId)
    const binding = dshSessionId === undefined
      ? undefined
      : await this.#sessions.get(dshSessionId).catch(() => undefined)
    const workspace = await this.#workspaces.get(workspaceId).catch(() => undefined)

    const remembered = dshSessionId === undefined ? undefined : this.#sessionRules.get(dshSessionId)
    if (remembered !== undefined && binding !== undefined) {
      const matched = remembered.find((rule) => matchesWidenedRule(rule, params.toolCall, binding.cwd))
      const allowOnce = findAllowOnce(params.options)
      if (matched !== undefined && allowOnce !== undefined) {
        await this.#auditDecision({
          workspace,
          dshSessionId: dshSessionId ?? params.sessionId,
          kind: 'permission',
          tool: params.toolCall.name ?? params.toolCall.title,
          argsHash: hashArgs(params.toolCall.rawInput),
          decision: `auto:${matched}`,
        })
        this.#emitTranslator([{
          type: 'auto-approved',
          sessionId: dshSessionId ?? params.sessionId,
          seq: 0,
          replay: false,
          toolCallId: params.toolCall.toolCallId,
          rule: matched,
        }], dshSessionId ?? params.sessionId)
        return { outcome: 'selected', optionId: allowOnce.optionId }
      }
    }

    const decision = await this.#gate.request({
      sessionId: params.sessionId,
      ...(dshSessionId === undefined ? {} : { dshSessionId }),
      workspaceId,
      toolCall: params.toolCall,
      options: params.options,
      replay: dshSessionId !== undefined && this.#replaying.has(dshSessionId),
    })
    if (decision.kind === 'expired') {
      await this.#auditDecision({
        workspace,
        dshSessionId: dshSessionId ?? params.sessionId,
        kind: 'permission',
        tool: params.toolCall.name ?? params.toolCall.title,
        argsHash: hashArgs(params.toolCall.rawInput),
        decision: `expired:${decision.reason}`,
      })
      const reject = findReject(params.options)
      return reject === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: reject.optionId }
    }
    const option = params.options.find((candidate) => candidate.optionId === decision.optionId)
    await this.#auditDecision({
      workspace,
      dshSessionId: dshSessionId ?? params.sessionId,
      kind: 'permission',
      tool: params.toolCall.name ?? params.toolCall.title,
      argsHash: hashArgs(params.toolCall.rawInput),
      decision: normalizeOptionKind(option?.kind ?? 'selected'),
    })
    return { outcome: 'selected', optionId: decision.optionId }
  }

  async #auditDecision(input: {
    readonly workspace: CcwWorkspace | undefined
    readonly dshSessionId: string
    readonly kind: 'permission' | 'widen' | 'plan' | 'session'
    readonly tool?: string
    readonly argsHash?: string
    readonly decision: string
    readonly latencyMs?: number
  }): Promise<void> {
    await this.#auditReady
    await this.#audit.append({
      host: input.workspace?.hostId ?? 'unknown',
      workspace: input.workspace?.id ?? 'unknown',
      session: input.dshSessionId,
      kind: input.kind,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.argsHash === undefined ? {} : { argsHash: input.argsHash }),
      decision: input.decision,
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    }).catch(() => undefined)
  }

  async #persistSequences(): Promise<void> {
    for (const [dshSessionId, seq] of this.#sequences.entries()) {
      await this.#sessions.update(dshSessionId, { lastEventSeq: seq }).catch(() => undefined)
    }
  }

  #emit(event: CcwHostEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A failed listener must not stop delivery to the others.
      }
    }
  }
}

/** Convenience constructor used by the DSH entry and tests. */
export function createService(options: CcwServiceOptions): CcwService {
  return new CcwService(options)
}

function toolNameOf(toolCall: { readonly name?: string | null; readonly title?: string }): string | undefined {
  return toolCall.name ?? toolCall.title ?? undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
