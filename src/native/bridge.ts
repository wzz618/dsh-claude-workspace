import type { ResolvedConfig } from '../config.ts'
import { CcwError } from '../util/errors.ts'

/**
 * Creates a DSH-native Session whose Agent runs on the ACP route registered
 * by the ACP adapter, so Claude conversations use DSH's own conversation UI
 * instead of the plugin's side-panel console.
 *
 * The plugin stays free of `@deepseek-ai/*` imports: every DSH service is read
 * through {@link ServiceLookup}, which keeps the installed profile's module
 * instances authoritative.
 */

/** Minimal DSH Agent API used to create one Session. */
export interface NativeAgents {
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string }
    readonly agentOptions?: { readonly provider: string; readonly model?: string }
  }): Promise<{ readonly agent: { readonly id: string; readonly session: unknown } }>
}

/** Minimal DSH workspace registry used to make the Session appear in the sidebar. */
export interface NativeWorkspaceRegistry {
  get(workspaceId: string): NativeWorkspace | undefined
}

/** One registered DSH workspace. */
export interface NativeWorkspace {
  attachSession(sessionId: string): Promise<void>
}

/** Minimal permission-preset API used to opt the new Session into Claude's own prompts. */
export interface NativePermissionPresets {
  set(session: unknown, name: string): void
  readonly names: readonly string[]
}

/** Reads DSH services without declaring them as static injections. */
export interface ServiceLookup {
  get(serviceName: string): unknown
}

/** Outcome of one native-session creation. */
export interface NativeSessionResult {
  readonly sessionId: string
  readonly workspaceAttached: boolean
  readonly permissionPreset?: string
  /** Non-fatal facts the caller should show next to the new Session. */
  readonly warnings: readonly string[]
}

/** How the native entry resolves one workspace to a Session. */
export interface NativeSessionInput {
  /** Absolute Claude working directory (remote path for SSH workspaces). */
  readonly cwd: string
  /** DSH workspace id; the Session is attached to it before it is returned. */
  readonly dshWorkspaceId?: string
  /** Adapter provider route for the workspace's host; defaults to `native.provider`. */
  readonly provider?: string
  /** Pre-minted Session identity, so callers can persist routing before creation. */
  readonly sessionId?: string
}

/** Creates DSH-native Claude Sessions through the ACP route. */
export class NativeSessionBridge {
  readonly #lookup: ServiceLookup
  readonly #config: ResolvedConfig['native']
  readonly #newSessionId: () => string

  /**
   * @param lookup - DSH context exposing `get(name)`.
   * @param config - Resolved `native` configuration.
   * @param newSessionId - Session id generator; the default matches DSH's own `session-<uuid>` form.
   */
  constructor(
    lookup: ServiceLookup,
    config: ResolvedConfig['native'],
    newSessionId: () => string,
  ) {
    this.#lookup = lookup
    this.#config = config
    this.#newSessionId = newSessionId
  }

  /** True when the DSH Agent service is reachable. */
  get available(): boolean {
    return this.#agents() !== undefined
  }

  /**
   * Create one Session on the configured ACP provider.
   *
   * The Session is created, attached to its DSH workspace, and switched to the
   * configured permission preset in that order. A failure after creation
   * reports the created Session identity so the caller can still open it.
   *
   * @param input - Working directory, provider route, and optional DSH workspace id.
   * @returns the created Session identity and non-fatal warnings.
   * @throws {CcwError} `native-unavailable` without the Agent service,
   * `workspace-registration-failed` when attachment is required but impossible,
   * or `native-session-failed` when DSH rejects the creation.
   */
  async create(input: NativeSessionInput): Promise<NativeSessionResult> {
    const agents = this.#agents()
    if (agents === undefined) {
      throw new CcwError(
        'native-unavailable',
        'the DSH Agent service is unavailable; native Claude sessions need a running DSH Host',
      )
    }
    const workspaceRegistry = this.#service<NativeWorkspaceRegistry>('workspaceRegistry')
    if (this.#config.attachToWorkspace && (input.dshWorkspaceId === undefined || workspaceRegistry === undefined)) {
      throw new CcwError(
        'workspace-registration-failed',
        input.dshWorkspaceId === undefined
          ? `the workspace has no DSH workspace id, so a session created for ${input.cwd} would not appear in the sidebar; reopen the workspace or restart DSH to register it`
          : 'the DSH workspace registry is unavailable, so a native session could not be attached to its workspace',
        { cwd: input.cwd, ...(input.dshWorkspaceId === undefined ? {} : { dshWorkspaceId: input.dshWorkspaceId }) },
      )
    }

    const sessionId = input.sessionId ?? this.#newSessionId()
    const provider = input.provider ?? this.#config.provider
    const created = await this.#createAgent(agents, sessionId, input.cwd, provider)
    const warnings: string[] = []

    let workspaceAttached = false
    if (this.#config.attachToWorkspace && input.dshWorkspaceId !== undefined && workspaceRegistry !== undefined) {
      const workspace = workspaceRegistry.get(input.dshWorkspaceId)
      if (workspace === undefined) {
        warnings.push(`DSH workspace ${input.dshWorkspaceId} is gone; the session was created but not added to the sidebar`)
      } else {
        try {
          await workspace.attachSession(sessionId)
          workspaceAttached = true
        } catch (error) {
          warnings.push(`session ${sessionId} was created but could not be attached to workspace ${input.dshWorkspaceId}: ${messageOf(error)}`)
        }
      }
    }

    const permissionPresets = this.#service<NativePermissionPresets>('permissionPresets')
    let permissionPreset: string | undefined
    if (permissionPresets === undefined) {
      warnings.push('DSH permission presets are unavailable; choose Full access in the session before the first prompt')
    } else {
      try {
        permissionPresets.set(created.agent.session, this.#config.permissionPreset)
        permissionPreset = this.#config.permissionPreset
      } catch (error) {
        warnings.push(`could not apply permission preset "${this.#config.permissionPreset}": ${messageOf(error)}; known presets: ${permissionPresets.names.join(', ')}`)
      }
    }

    return {
      sessionId,
      workspaceAttached,
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      warnings,
    }
  }

  #agents(): NativeAgents | undefined {
    const agents = this.#service<NativeAgents>('agents')
    return agents !== undefined && typeof agents.create === 'function' ? agents : undefined
  }

  #service<Service>(name: string): Service | undefined {
    try {
      return this.#lookup.get(name) as Service | undefined
    } catch {
      return undefined
    }
  }

  async #createAgent(
    agents: NativeAgents,
    sessionId: string,
    cwd: string,
    provider: string,
  ): Promise<{ readonly agent: { readonly id: string; readonly session: unknown } }> {
    try {
      return await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { provider, model: this.#config.model },
      })
    } catch (error) {
      throw new CcwError(
        'native-session-failed',
        `DSH could not create a native session on provider "${provider}": ${messageOf(error)}. `
          + 'Install the ACP adapter and its Claude Code profile, or use the Claude console for this workspace.',
        { cwd, provider, model: this.#config.model },
        { cause: error },
      )
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
