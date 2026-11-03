import type { WorkspaceStrategy } from '../config.ts'

/** Where a workspace's Claude Code process runs. */
export type HostRef = { readonly kind: 'local' } | { readonly kind: 'ssh'; readonly alias: string }

/** One workspace managed by the plugin and registered with DSH. */
export interface CcwWorkspace {
  /** Plugin-side id (`ws_…`), stable across restarts. */
  readonly id: string
  /** Display title; renaming does not rename the directory. */
  title: string
  /** Key in the resolved `hosts` map. */
  readonly hostId: string
  readonly host: HostRef
  /** Absolute directory on the host. */
  readonly dir: string
  /** Absolute derivative root for this workspace. */
  readonly baseDir: string
  readonly strategy: WorkspaceStrategy
  readonly createdAt: number
  lastUsedAt: number
  readonly pinned?: boolean
  /** `removed` records stay on disk so the directory can be re-added. */
  state: 'active' | 'removed'
  /** Workspace id returned by DSH's workspace registry, when registered. */
  dshWorkspaceId?: string
  /** True when the directory was derived rather than supplied by the user. */
  readonly derived: boolean
}

/** DSH session ↔ ACP session binding, persisted atomically. */
export interface CcwSessionBinding {
  readonly dshSessionId: string
  readonly workspaceId: string
  /** `session/new` id, or the id passed to `session/load`. */
  acpSessionId?: string
  /** Claude working directory for this DSH session, derived per B6. */
  cwd: string
  model?: string
  effort?: string
  mode?: string
  readonly createdAt: number
  lastTurnAt?: number
  /** Last ACP event sequence the client rendered; replay deduplication uses it. */
  lastEventSeq: number
  /** True when the binding exists but its ACP session must be loaded again. */
  needsLoad: boolean
  /** Opaque revision of the agent's on-disk session log at our last write. */
  revision?: string
}

/** On-disk shape of `workspaces.json`. */
export interface WorkspacesFile {
  readonly version: 1
  readonly workspaces: CcwWorkspace[]
}

/** On-disk shape of `sessions.json`. */
export interface SessionsFile {
  readonly version: 1
  readonly sessions: CcwSessionBinding[]
}
