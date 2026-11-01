import { CcwConfigError, resolveConfig, type CcwConfigInput } from './config.ts'
import { registerCcwHttp, type ExactRoute } from './http.ts'
import { createService } from './service.ts'
import type { WorkspaceControllerLike } from './workspace/registry.ts'

/** Cordis services this plugin reads. `webServer` is attached when present. */
export const name = 'dsh-claude-workspace'

export const inject: readonly string[] = []

/** Minimal slice of the Cordis context this entry point uses. */
interface CordisContext {
  get?(serviceName: string): unknown
  inject?(names: readonly string[], callback: (scope: CordisContext) => void): void
  effect?(callback: () => () => void, label?: string): void
  webServer?: { register(route: ExactRoute): void }
  workspaceController?: WorkspaceControllerLike
  logger?(name: string): { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/**
 * Standard-schema configuration validator.
 *
 * The Loader merges defaults itself only for schemastery schemas; this object
 * validates the same fields and lets `resolveConfig` apply defaults inside
 * `apply`. Unknown keys and invalid values are reported at load time.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-claude-workspace',
    validate(value: unknown): { value: CcwConfigInput } | { issues: { message: string }[] } {
      try {
        resolveConfig(value as CcwConfigInput)
        return { value: (typeof value === 'object' && value !== null ? value : {}) as CcwConfigInput }
      } catch (error) {
        if (error instanceof CcwConfigError) {
          return { issues: error.issues.map((message) => ({ message })) }
        }
        throw error
      }
    },
  },
}

/**
 * Host entry point.
 *
 * The plugin does not take over `agent-loop` yet: P1 exposes the workspace,
 * runtime, permission, and audit layers over a loopback HTTP API. Taking over
 * the agent loop and the model-selection row is P2 and must add the
 * `agent-loop` / `ui-model-selection` disable rows together with the conflict
 * check against other factories.
 *
 * @param ctx - Cordis context; `webServer` and `workspaceController` are optional.
 * @param config - Loader configuration map.
 */
export function apply(ctx: CordisContext, config: CcwConfigInput = {}): void {
  const controller = readService<WorkspaceControllerLike>(ctx, 'workspaceController')
  const service = createService({
    config,
    ...(controller === undefined ? {} : { workspaceController: controller }),
  })

  const attachServer = (scope: CordisContext): void => {
    if (scope.webServer !== undefined) registerCcwHttp(service, (route) => scope.webServer!.register(route))
    else ctx.logger?.('dsh-claude-workspace').warn('webServer is unavailable; the CCW API is not mounted')
  }
  if (ctx.webServer !== undefined) {
    attachServer(ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => attachServer(scope))
  } else {
    ctx.logger?.('dsh-claude-workspace').warn('webServer is unavailable; the CCW API is not mounted')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        void service.close()
      },
      'dsh-claude-workspace: stop Claude Code processes',
    )
  }
  ctx.logger?.('dsh-claude-workspace').info(
    `ready: ${service.listHosts().length} host(s), data directory ${service.config.dataDir}`,
  )
}

function readService<T>(ctx: CordisContext, name: string): T | undefined {
  const fromContext = ctx[name as keyof CordisContext]
  if (fromContext !== undefined) return fromContext as T
  return typeof ctx.get === 'function' ? (ctx.get(name) as T | undefined) : undefined
}

export { CcwService, createService } from './service.ts'
export { resolveConfig, CcwConfigError } from './config.ts'
export type { CcwConfigInput, ResolvedConfig } from './config.ts'
export { createCcwHttpHandler, CCW_HTTP_PATHS, registerCcwHttp } from './http.ts'
export type { CcwHostEvent } from './service.ts'
