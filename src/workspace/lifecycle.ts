import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, isAbsolute, join, posix } from 'node:path'
import type { ResolvedConfig, WorkspaceStrategy } from '../config.ts'
import type { HostOps } from '../host/types.ts'
import { CcwError } from '../util/errors.ts'
import { deriveDirectory } from './naming.ts'
import type { WorkspaceRegistry } from './registry.ts'
import type { WorkspaceStore } from './store.ts'
import type { CcwWorkspace, HostRef } from './types.ts'

/** Collaborators the workspace lifecycle calls. */
export interface WorkspaceLifecycleDeps {
  readonly config: ResolvedConfig
  readonly workspaces: WorkspaceStore
  readonly registry: WorkspaceRegistry
  host(hostId: string): HostOps
  closeHost?(hostId: string): void
  now?: () => number
  newId?: () => string
}

/** Input for creating or resolving a workspace. */
export interface CreateWorkspaceInput {
  readonly title?: string
  readonly hostId: string
  /** Existing or to-be-created absolute directory on the host. */
  readonly dir?: string
  /** Directory policy for sessions; defaults to the configured policy. */
  readonly strategy?: WorkspaceStrategy
  /** Overrides the configured derivative root. */
  readonly baseDir?: string
}

/** Result of a create request, including non-fatal notices for the UI. */
export interface CreateWorkspaceResult {
  readonly workspace: CcwWorkspace
  readonly created: boolean
  readonly warnings: readonly string[]
}

/**
 * Creates or resolves one workspace.
 *
 * Order is deliberate: directory first, DSH registration second, durable
 * record last. A registration failure writes no record, so plugin state never
 * claims a workspace the sidebar does not show; a record failure removes the
 * just-created registration. The directory is retained in both cases.
 *
 * @param deps - Stores, registry, and host resolver.
 * @param input - Host, optional directory, and optional session policy.
 * @returns The workspace and whether this call created it.
 */
export async function createWorkspace(
  deps: WorkspaceLifecycleDeps,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `ws_${randomUUID().replaceAll('-', '').slice(0, 12)}`)
  const hostConfig = deps.config.hosts[input.hostId]
  if (hostConfig === undefined) {
    throw new CcwError('config-invalid', `host "${input.hostId}" is not configured`, { hostId: input.hostId })
  }
  const host = deps.host(input.hostId)
  const hostRef: HostRef = hostConfig.kind === 'ssh' ? { kind: 'ssh', alias: hostConfig.alias ?? input.hostId } : { kind: 'local' }
  const hostIdentity = hostRef.kind === 'ssh' ? `ssh:${hostRef.alias}` : 'local'
  const strategy = input.strategy ?? deps.config.workspaces.strategy
  const createdAt = now()
  const id = newId()
  const baseDir = input.baseDir === undefined ? deps.config.workspaces.baseDir : absoluteHostPath(input.baseDir, 'baseDir')
  const warnings: string[] = []

  let dir: string
  let derived: boolean
  if (input.dir !== undefined) {
    dir = absoluteHostPath(input.dir, 'dir')
    await ensureDirectory(host, dir)
    const resolved = await host.realpath(dir)
    if (resolved !== dir) dir = resolved
    derived = false
  } else {
    dir = deriveDirectory({
      workspaceId: id,
      strategy: 'per-workspace',
      createdAt,
      hostIdentity,
      baseDir,
      prefix: deps.config.workspaces.prefix,
    })
    await host.mkdirp(dir)
    const info = await host.stat(dir)
    if (!info.isDirectory) {
      throw new CcwError('dir-create-failed', `${dir} was created but is not a directory`, { path: dir, host: input.hostId })
    }
    derived = true
  }

  const existing = await deps.workspaces.findByDirectory(input.hostId, dir)
  if (existing !== undefined) {
    return {
      workspace: existing,
      created: false,
      warnings: [`${dir} is already managed as workspace "${existing.title}"`],
    }
  }

  const title = normalizeTitle(input.title, dir)
  // SSH workspaces keep their remote directory in the CCW record; DSH owns a
  // local placeholder so no host-local directory is created at a remote path.
  const registrationPath = dshWorkspacePath(deps.config, id, hostRef, dir)
  if (hostRef.kind === 'ssh') await mkdir(registrationPath, { recursive: true, mode: 0o700 })
  const registration = await deps.registry.register({ path: registrationPath, title })
  if (registration === undefined && deps.registry.available) {
    throw new CcwError('workspace-registration-failed', `DSH did not return a workspace for ${dir}`, { path: dir })
  }
  if (registration === undefined) {
    warnings.push('no DSH workspace controller is composed; this workspace exists only in the plugin registry')
  }

  const workspace: CcwWorkspace = {
    id,
    title,
    hostId: input.hostId,
    host: hostRef,
    dir,
    baseDir,
    strategy,
    createdAt,
    lastUsedAt: createdAt,
    state: 'active',
    ...(registration === undefined ? {} : { dshWorkspaceId: registration.id }),
    derived,
  }

  try {
    await deps.workspaces.create(workspace)
  } catch (error) {
    if (registration !== undefined) {
      await deps.registry.remove(registration.id).catch(() => undefined)
    }
    throw error
  }
  return { workspace, created: true, warnings }
}

/**
 * Local directory DSH registers for one workspace.
 *
 * SSH workspaces keep their remote directory on the CCW record; DSH receives an
 * empty local placeholder so its registry never creates host-local directories
 * at remote paths.
 *
 * @param config - Resolved plugin configuration.
 * @param workspaceId - Plugin workspace id.
 * @param host - Workspace host reference.
 * @param dir - Workspace directory on that host.
 * @returns the path passed to the DSH workspace controller.
 */
export function dshWorkspacePath(
  config: ResolvedConfig,
  workspaceId: string,
  host: HostRef,
  dir: string,
): string {
  return host.kind === 'ssh' ? join(config.dataDir, 'remote-workspaces', workspaceId) : dir
}

/**
 * Removes a workspace from the DSH registry and marks the plugin record
 * removed. The directory is never deleted here.
 *
 * @param deps - Stores and registry.
 * @param workspaceId - Plugin workspace id.
 * @returns The updated record.
 */
export async function removeWorkspace(deps: WorkspaceLifecycleDeps, workspaceId: string): Promise<CcwWorkspace> {
  const workspace = await deps.workspaces.get(workspaceId)
  if (workspace === undefined || workspace.state === 'removed') {
    throw new CcwError('workspace-not-found', `workspace ${workspaceId} does not exist`, { workspaceId })
  }
  if (workspace.dshWorkspaceId !== undefined) {
    try {
      await deps.registry.remove(workspace.dshWorkspaceId)
    } catch (error) {
      throw new CcwError(
        'workspace-registration-failed',
        `could not remove workspace "${workspace.title}" from DSH: ${messageOf(error)}`,
        { workspaceId, dshWorkspaceId: workspace.dshWorkspaceId },
        { cause: error },
      )
    }
  }
  deps.closeHost?.(workspace.hostId)
  return deps.workspaces.markRemoved(workspaceId)
}

/**
 * Deletes the directory of an already-removed, plugin-derived workspace.
 *
 * The destructive default is refusal: removal never deletes files. Explicit
 * deletion is limited to directories under the configured derivative root so a
 * user-supplied workspace can never be erased by this path.
 *
 * @param deps - Stores and host resolver.
 * @param workspaceId - Plugin workspace id.
 * @param confirmation - Must be `{ deleteDirectory: true }`.
 * @throws {CcwError} When the workspace is active or the directory is outside the root.
 */
export async function deleteWorkspaceDirectory(
  deps: Pick<WorkspaceLifecycleDeps, 'config' | 'workspaces' | 'host'>,
  workspaceId: string,
  confirmation: { readonly deleteDirectory?: boolean },
): Promise<void> {
  const workspace = await deps.workspaces.get(workspaceId)
  if (workspace === undefined) {
    throw new CcwError('workspace-not-found', `workspace ${workspaceId} does not exist`, { workspaceId })
  }
  if (confirmation.deleteDirectory !== true) {
    throw new CcwError('dir-not-found', 'directory deletion requires deleteDirectory: true', { workspaceId })
  }
  if (workspace.state !== 'removed') {
    throw new CcwError('dir-not-found', 'remove the workspace from DSH before deleting its directory', { workspaceId })
  }
  if (!workspace.derived || !isSubpath(workspace.baseDir, workspace.dir)) {
    throw new CcwError('dir-not-found', `refusing to delete ${workspace.dir}: it is not under ${workspace.baseDir}`, {
      workspaceId,
      path: workspace.dir,
    })
  }
  const host = deps.host(workspace.hostId)
  const result = await host.exec(['rm', '-rf', '--', workspace.dir])
  if (result.code !== 0) {
    throw new CcwError('dir-create-failed', `could not delete ${workspace.dir}: ${result.stderr.trim()}`, {
      workspaceId,
      path: workspace.dir,
    })
  }
}

/** Renames a workspace in the store and, when registered, in DSH. */
export async function renameWorkspace(
  deps: Pick<WorkspaceLifecycleDeps, 'workspaces' | 'registry'>,
  workspaceId: string,
  title: string,
): Promise<CcwWorkspace> {
  const trimmed = title.trim()
  if (trimmed.length === 0) {
    throw new CcwError('config-invalid', 'workspace title cannot be blank', { workspaceId })
  }
  const workspace = await deps.workspaces.get(workspaceId)
  if (workspace === undefined) {
    throw new CcwError('workspace-not-found', `workspace ${workspaceId} does not exist`, { workspaceId })
  }
  if (workspace.dshWorkspaceId !== undefined) await deps.registry.rename(workspace.dshWorkspaceId, trimmed)
  return deps.workspaces.update(workspaceId, { title: trimmed })
}

/**
 * Derives the Claude cwd for one DSH session (B6).
 *
 * `per-session` uses the session id plus creation time so each session gets a
 * fresh directory. `per-conversation` uses the session id without time, which
 * makes it the stable, one-directory-per-conversation policy available to a
 * DSH session.
 *
 * @param deps - Workspace record and configuration.
 * @param workspace - Owning workspace.
 * @param session - DSH session id and creation time.
 * @returns An absolute cwd on the workspace host.
 */
export function deriveSessionDirectory(
  deps: Pick<WorkspaceLifecycleDeps, 'config'>,
  workspace: CcwWorkspace,
  session: { readonly dshSessionId: string; readonly createdAt: number },
): string {
  const hostIdentity = workspace.host.kind === 'ssh' ? `ssh:${workspace.host.alias}` : 'local'
  switch (workspace.strategy) {
    case 'per-workspace':
      return workspace.dir
    case 'per-session':
      return deriveDirectory({
        workspaceId: workspace.id,
        strategy: 'per-session',
        sessionId: session.dshSessionId,
        createdAt: session.createdAt,
        hostIdentity,
        baseDir: workspace.baseDir,
        prefix: deps.config.workspaces.prefix,
      })
    case 'per-conversation':
      return deriveDirectory({
        workspaceId: workspace.id,
        strategy: 'per-conversation',
        conversationId: session.dshSessionId,
        createdAt: session.createdAt,
        hostIdentity,
        baseDir: workspace.baseDir,
        prefix: deps.config.workspaces.prefix,
      })
  }
}

/** Creates the session cwd when the strategy derives a per-session directory. */
export async function ensureSessionDirectory(host: HostOps, workspace: CcwWorkspace, cwd: string): Promise<void> {
  if (cwd === workspace.dir) return
  await host.mkdirp(cwd)
  const info = await host.stat(cwd)
  if (!info.isDirectory) {
    throw new CcwError('dir-create-failed', `${cwd} was created but is not a directory`, { path: cwd })
  }
}

/** Whether `candidate` is inside `root` (posix, normalized). */
export function isSubpath(root: string, candidate: string): boolean {
  const normalizedRoot = posix.normalize(root).replace(/\/+$/, '')
  const normalizedCandidate = posix.normalize(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function absoluteHostPath(value: string, field: string): string {
  if (!isAbsolute(value)) {
    throw new CcwError('config-invalid', `${field} must be an absolute path, got "${value}"`, { field, value })
  }
  const normalized = posix.normalize(value)
  if (normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new CcwError('config-invalid', `${field} must not contain "..", got "${value}"`, { field, value })
  }
  return normalized
}

async function ensureDirectory(host: HostOps, dir: string): Promise<void> {
  const info = await host.stat(dir)
  if (info.exists && !info.isDirectory) {
    throw new CcwError('dir-create-failed', `${dir} exists and is not a directory`, { path: dir })
  }
  if (!info.exists) await host.mkdirp(dir)
  const verified = await host.stat(dir)
  if (!verified.isDirectory) {
    throw new CcwError('dir-create-failed', `${dir} is not a directory after creation`, { path: dir })
  }
}

function normalizeTitle(title: string | undefined, dir: string): string {
  const candidate = title?.trim() ?? ''
  return candidate.length > 0 ? candidate : basename(dir) || 'claude-code'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
