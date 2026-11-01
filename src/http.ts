import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WidenScope } from './config.ts'
import { CcwError } from './util/errors.ts'
import type { CcwService } from './service.ts'
import type { PlanDecision } from './gate/plan.ts'

/** Loopback paths served by the Host half. */
export const CCW_HTTP_PATHS = [
  '/api/dsh-claude-workspace/status',
  '/api/dsh-claude-workspace/hosts',
  '/api/dsh-claude-workspace/hosts/probe',
  '/api/dsh-claude-workspace/workspaces',
  '/api/dsh-claude-workspace/workspaces/create',
  '/api/dsh-claude-workspace/workspaces/rename',
  '/api/dsh-claude-workspace/workspaces/remove',
  '/api/dsh-claude-workspace/workspaces/delete-directory',
  '/api/dsh-claude-workspace/sessions',
  '/api/dsh-claude-workspace/sessions/open',
  '/api/dsh-claude-workspace/sessions/prompt',
  '/api/dsh-claude-workspace/sessions/cancel',
  '/api/dsh-claude-workspace/sessions/option',
  '/api/dsh-claude-workspace/sessions/reattach',
  '/api/dsh-claude-workspace/approvals',
  '/api/dsh-claude-workspace/approvals/answer',
  '/api/dsh-claude-workspace/approvals/widen-preview',
  '/api/dsh-claude-workspace/approvals/widen',
  '/api/dsh-claude-workspace/rules',
  '/api/dsh-claude-workspace/rules/revoke',
  '/api/dsh-claude-workspace/plans',
  '/api/dsh-claude-workspace/plans/decide',
  '/api/dsh-claude-workspace/audit',
] as const

const MAX_BODY_BYTES = 1024 * 1024

/** Signature accepted by `ctx.webServer.register`. */
export interface ExactRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void
}

/**
 * Registers every CCW route with a DSH web server.
 *
 * All routes answer only loopback requests: the API can start processes and
 * write permission rules, so it must not be reachable from the network.
 *
 * @param service - Plugin service.
 * @param register - `scope.webServer.register`.
 */
export function registerCcwHttp(service: CcwService, register: (route: ExactRoute) => void): void {
  const handler = createCcwHttpHandler(service)
  for (const path of CCW_HTTP_PATHS) {
    register({ kind: 'exact', path, handler })
  }
}

/** Creates the shared request handler; exported for tests. */
export function createCcwHttpHandler(service: CcwService): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(service, req, res)
  }
}

async function handle(service: CcwService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback access required' } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    const body = req.method === 'GET' ? undefined : await readJsonBody(req)
    const data = await dispatch(service, req.method ?? 'GET', url.pathname, url, body)
    sendJson(res, 200, { ok: true, data })
  } catch (error) {
    sendError(res, error)
  }
}

async function dispatch(
  service: CcwService,
  method: string,
  path: string,
  url: URL,
  body: Record<string, unknown> | undefined,
): Promise<unknown> {
  const key = `${method} ${path}`
  switch (key) {
    case 'GET /api/dsh-claude-workspace/status':
      return {
        version: '0.1.0',
        dataDir: service.config.dataDir,
        defaultHost: service.config.defaultHost,
        strategy: service.config.workspaces.strategy,
        prefix: service.config.workspaces.prefix,
        registryAvailable: service.registryAvailable,
        approvalsTimeoutMs: service.config.approvals.timeoutMs,
        acp: {
          executable: service.config.acp.executable,
          minimumVersion: service.config.acp.minimumVersion,
          maximumVersionExclusive: service.config.acp.maximumVersionExclusive,
        },
      }
    case 'GET /api/dsh-claude-workspace/hosts':
      return { hosts: service.listHosts() }
    case 'POST /api/dsh-claude-workspace/hosts/probe': {
      const hostId = requiredString(body, 'hostId')
      const cwd = optionalString(body, 'cwd')
      return { health: await service.healthCheck(hostId, cwd === undefined ? {} : { cwd }) }
    }
    case 'GET /api/dsh-claude-workspace/workspaces':
      return { workspaces: await service.listWorkspaces() }
    case 'POST /api/dsh-claude-workspace/workspaces/create': {
      const hostId = requiredString(body, 'hostId')
      const title = optionalString(body, 'title')
      const dir = optionalString(body, 'dir')
      const strategy = optionalString(body, 'strategy')
      if (strategy !== undefined && !['per-workspace', 'per-session', 'per-conversation'].includes(strategy)) {
        throw new CcwError('config-invalid', 'strategy must be per-workspace, per-session, or per-conversation', { strategy })
      }
      return service.createWorkspace({
        hostId,
        ...(title === undefined ? {} : { title }),
        ...(dir === undefined ? {} : { dir }),
        ...(strategy === undefined ? {} : { strategy: strategy as 'per-workspace' | 'per-session' | 'per-conversation' }),
      })
    }
    case 'POST /api/dsh-claude-workspace/workspaces/rename':
      return { workspace: await service.renameWorkspace(requiredString(body, 'workspaceId'), requiredString(body, 'title')) }
    case 'POST /api/dsh-claude-workspace/workspaces/remove':
      return { workspace: await service.removeWorkspace(requiredString(body, 'workspaceId')) }
    case 'POST /api/dsh-claude-workspace/workspaces/delete-directory':
      await service.deleteWorkspaceDirectory(requiredString(body, 'workspaceId'), {
        deleteDirectory: body?.deleteDirectory === true,
      })
      return { deleted: true }
    case 'GET /api/dsh-claude-workspace/sessions':
      return { sessions: await service.listSessions() }
    case 'POST /api/dsh-claude-workspace/sessions/open':
      return service.openSession({
        workspaceId: requiredString(body, 'workspaceId'),
        dshSessionId: requiredString(body, 'dshSessionId'),
        ...optionalOption(body, 'model'),
        ...optionalOption(body, 'effort'),
        ...optionalOption(body, 'mode'),
      })
    case 'POST /api/dsh-claude-workspace/sessions/prompt': {
      const images = parseImages(body?.images)
      return service.prompt({
        dshSessionId: requiredString(body, 'dshSessionId'),
        text: requiredString(body, 'text'),
        ...(images === undefined ? {} : { images }),
      })
    }
    case 'POST /api/dsh-claude-workspace/sessions/cancel':
      await service.cancelSession(requiredString(body, 'dshSessionId'))
      return { cancelled: true }
    case 'POST /api/dsh-claude-workspace/sessions/option':
      return {
        binding: await service.setOption(
          requiredString(body, 'dshSessionId'),
          requiredString(body, 'configId'),
          requiredValue(body, 'value'),
        ),
      }
    case 'POST /api/dsh-claude-workspace/sessions/reattach':
      return service.reattach(
        requiredString(body, 'dshSessionId'),
        typeof body?.sinceSeq === 'number' ? body.sinceSeq : undefined,
      )
    case 'GET /api/dsh-claude-workspace/approvals':
      return { pending: service.pendingApprovals(url.searchParams.get('dshSessionId') ?? undefined) }
    case 'POST /api/dsh-claude-workspace/approvals/answer':
      await service.answerPermission(requiredString(body, 'requestId'), requiredString(body, 'optionId'))
      return { answered: true }
    case 'POST /api/dsh-claude-workspace/approvals/widen-preview':
      return service.previewWiden(
        requiredString(body, 'requestId'),
        requiredScope(body),
        optionalString(body, 'customRule'),
        optionalTarget(body),
      )
    case 'POST /api/dsh-claude-workspace/approvals/widen':
      return service.widenPermission({
        requestId: requiredString(body, 'requestId'),
        scope: requiredScope(body),
        ...(optionalString(body, 'customRule') === undefined ? {} : { customRule: optionalString(body, 'customRule')! }),
        ...(optionalTarget(body) === undefined ? {} : { target: optionalTarget(body)! }),
        ...(body?.confirmed === true ? { confirmed: true } : {}),
      })
    case 'GET /api/dsh-claude-workspace/rules':
      return { rules: await service.writtenRules() }
    case 'POST /api/dsh-claude-workspace/rules/revoke':
      return { removed: await service.revokeRule(requiredString(body, 'id')) }
    case 'GET /api/dsh-claude-workspace/plans': {
      const dshSessionId = requiredString(url.searchParams, 'dshSessionId')
      return { plan: service.plan(dshSessionId) ?? null }
    }
    case 'POST /api/dsh-claude-workspace/plans/decide': {
      const dshSessionId = requiredString(body, 'dshSessionId')
      const decision = parsePlanDecision(body)
      return { plan: await service.decidePlan(dshSessionId, decision) }
    }
    case 'GET /api/dsh-claude-workspace/audit': {
      const day = url.searchParams.get('day') ?? new Date().toISOString().slice(0, 10)
      return { entries: await service.auditEntries(day) }
    }
    default:
      throw new CcwError('config-invalid', `no route for ${method} ${path}`, { method, path })
  }
}

function parsePlanDecision(body: Record<string, unknown> | undefined): PlanDecision {
  const kind = requiredString(body, 'decision')
  if (kind === 'approve') {
    const feedback = optionalString(body, 'feedback')
    return { kind: 'approve', ...(feedback === undefined ? {} : { feedback }) }
  }
  if (kind === 'revise') return { kind: 'revise', feedback: requiredString(body, 'feedback') }
  if (kind === 'cancel') return { kind: 'cancel' }
  throw new CcwError('config-invalid', 'decision must be approve, revise, or cancel', { decision: kind })
}

/** Where the DSH web server attaches. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) {
      throw new CcwError('config-invalid', 'request body is too large', { limit: MAX_BODY_BYTES })
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CcwError('config-invalid', 'request body is not valid JSON', {})
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CcwError('config-invalid', 'request body must be a JSON object', {})
  }
  return parsed as Record<string, unknown>
}

function requiredString(source: Record<string, unknown> | URLSearchParams | undefined, key: string): string {
  const value = source instanceof URLSearchParams ? source.get(key) ?? undefined : source?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new CcwError('config-invalid', `${key} must be a non-empty string`, { field: key })
  }
  return value
}

function optionalString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new CcwError('config-invalid', `${key} must be a non-empty string`, { field: key })
  }
  return value
}

function requiredValue(body: Record<string, unknown> | undefined, key: string): string | boolean {
  const value = body?.[key]
  if (typeof value !== 'string' && typeof value !== 'boolean') {
    throw new CcwError('config-invalid', `${key} must be a string or boolean`, { field: key })
  }
  return value
}

function requiredScope(body: Record<string, unknown> | undefined): WidenScope {
  const value = requiredString(body, 'scope')
  if (value !== 'command' && value !== 'prefix' && value !== 'tool') {
    throw new CcwError('config-invalid', 'scope must be command, prefix, or tool', { scope: value })
  }
  return value
}

function optionalTarget(body: Record<string, unknown> | undefined): 'project' | 'user' | undefined {
  const value = optionalString(body, 'target')
  if (value === undefined) return undefined
  if (value !== 'project' && value !== 'user') {
    throw new CcwError('config-invalid', 'target must be project or user', { target: value })
  }
  return value
}

function optionalOption(body: Record<string, unknown> | undefined, key: 'model' | 'effort' | 'mode'): Record<string, string> {
  const value = optionalString(body, key)
  return value === undefined ? {} : { [key]: value }
}

function parseImages(value: unknown): { data: string; mimeType: string }[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new CcwError('config-invalid', 'images must be an array', {})
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new CcwError('config-invalid', `images[${index}] must be an object`, { index })
    }
    const record = entry as Record<string, unknown>
    if (typeof record.data !== 'string' || typeof record.mimeType !== 'string') {
      throw new CcwError('config-invalid', `images[${index}] requires string data and mimeType`, { index })
    }
    return { data: record.data, mimeType: record.mimeType }
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof CcwError) {
    const status = statusFor(error.code)
    sendJson(res, status, {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    })
    return
  }
  sendJson(res, 500, {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  })
}

function statusFor(code: CcwError['code']): number {
  switch (code) {
    case 'workspace-not-found':
    case 'session-not-found':
      return 404
    case 'permission-expired':
    case 'confirmation-required':
      return 409
    case 'settings-invalid':
    case 'state-invalid':
      return 422
    default:
      return 400
  }
}
