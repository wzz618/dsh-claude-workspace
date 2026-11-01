import { join } from 'node:path'
import { atomicWriteJson, readJsonFile } from '../util/atomic.ts'
import { CcwError } from '../util/errors.ts'
import { SerialQueue } from '../util/queue.ts'
import type { CcwSessionBinding, CcwWorkspace, SessionsFile, WorkspacesFile } from './types.ts'

const WORKSPACES_VERSION = 1
const SESSIONS_VERSION = 1

/**
 * Workspace records persisted at `<dataDir>/workspaces.json`.
 *
 * Every read goes to disk and every mutation is a read-modify-write inside one
 * serial queue, so a second DSH process editing the same file is noticed
 * instead of being overwritten from a stale startup snapshot.
 */
export class WorkspaceStore {
  readonly #path: string
  readonly #queue = new SerialQueue()

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'workspaces.json')
  }

  /** Returns every record, including removed ones. */
  async list(): Promise<CcwWorkspace[]> {
    return (await this.#read()).workspaces
  }

  /** Returns active records only. */
  async listActive(): Promise<CcwWorkspace[]> {
    return (await this.#read()).workspaces.filter((workspace) => workspace.state === 'active')
  }

  /** Looks up one record by plugin id. */
  async get(id: string): Promise<CcwWorkspace | undefined> {
    return (await this.#read()).workspaces.find((workspace) => workspace.id === id)
  }

  /** Finds an active record by its host directory. */
  async findByDirectory(hostId: string, dir: string): Promise<CcwWorkspace | undefined> {
    return (await this.#read()).workspaces.find(
      (workspace) => workspace.state === 'active' && workspace.hostId === hostId && workspace.dir === dir,
    )
  }

  /** Inserts a new record; ids must be unique. */
  async create(workspace: CcwWorkspace): Promise<CcwWorkspace> {
    return this.#queue.run('workspaces', async () => {
      const file = await this.#read()
      if (file.workspaces.some((entry) => entry.id === workspace.id)) {
        throw new CcwError('state-invalid', `workspace ${workspace.id} already exists`, { workspaceId: workspace.id })
      }
      await this.#write({ version: WORKSPACES_VERSION, workspaces: [...file.workspaces, workspace] })
      return workspace
    })
  }

  /** Applies a partial update to one record. */
  async update(id: string, patch: Partial<Omit<CcwWorkspace, 'id'>>): Promise<CcwWorkspace> {
    return this.#queue.run('workspaces', async () => {
      const file = await this.#read()
      const index = file.workspaces.findIndex((workspace) => workspace.id === id)
      if (index < 0) throw new CcwError('workspace-not-found', `workspace ${id} does not exist`, { workspaceId: id })
      const existing = file.workspaces[index]!
      const updated: CcwWorkspace = { ...existing, ...patch, id }
      const workspaces = [...file.workspaces]
      workspaces[index] = updated
      await this.#write({ version: WORKSPACES_VERSION, workspaces })
      return updated
    })
  }

  /** Marks a record removed without deleting its directory. */
  async markRemoved(id: string): Promise<CcwWorkspace> {
    return this.update(id, { state: 'removed', lastUsedAt: Date.now() })
  }

  async #read(): Promise<WorkspacesFile> {
    const file = await readJsonFile<WorkspacesFile>(this.#path, { version: WORKSPACES_VERSION, workspaces: [] })
    if (file.version !== WORKSPACES_VERSION || !Array.isArray(file.workspaces)) {
      throw new CcwError('state-invalid', `${this.#path} has an unsupported format`, { path: this.#path })
    }
    return file
  }

  async #write(file: WorkspacesFile): Promise<void> {
    await atomicWriteJson(this.#path, file)
  }
}

/**
 * Session bindings persisted at `<dataDir>/sessions.json`.
 *
 * Bindings survive a DSH restart so the runtime can call `session/load`
 * instead of pretending a lost session still exists.
 */
export class SessionStore {
  readonly #path: string
  readonly #queue = new SerialQueue()

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'sessions.json')
  }

  async list(): Promise<CcwSessionBinding[]> {
    return (await this.#read()).sessions
  }

  async listByWorkspace(workspaceId: string): Promise<CcwSessionBinding[]> {
    return (await this.#read()).sessions.filter((session) => session.workspaceId === workspaceId)
  }

  async get(dshSessionId: string): Promise<CcwSessionBinding | undefined> {
    return (await this.#read()).sessions.find((session) => session.dshSessionId === dshSessionId)
  }

  async findByAcpSessionId(acpSessionId: string): Promise<CcwSessionBinding | undefined> {
    return (await this.#read()).sessions.find((session) => session.acpSessionId === acpSessionId)
  }

  /** Inserts or replaces one binding. */
  async upsert(binding: CcwSessionBinding): Promise<CcwSessionBinding> {
    return this.#queue.run('sessions', async () => {
      const file = await this.#read()
      const index = file.sessions.findIndex((session) => session.dshSessionId === binding.dshSessionId)
      const sessions = [...file.sessions]
      if (index >= 0) sessions[index] = binding
      else sessions.push(binding)
      await this.#write({ version: SESSIONS_VERSION, sessions })
      return binding
    })
  }

  /** Applies a partial update to one binding. */
  async update(dshSessionId: string, patch: Partial<Omit<CcwSessionBinding, 'dshSessionId'>>): Promise<CcwSessionBinding> {
    return this.#queue.run('sessions', async () => {
      const file = await this.#read()
      const index = file.sessions.findIndex((session) => session.dshSessionId === dshSessionId)
      if (index < 0) throw new CcwError('session-not-found', `session ${dshSessionId} is not bound`, { sessionId: dshSessionId })
      const updated: CcwSessionBinding = { ...file.sessions[index]!, ...patch, dshSessionId }
      const sessions = [...file.sessions]
      sessions[index] = updated
      await this.#write({ version: SESSIONS_VERSION, sessions })
      return updated
    })
  }

  /** Removes a binding and returns the removed record. */
  async remove(dshSessionId: string): Promise<CcwSessionBinding | undefined> {
    return this.#queue.run('sessions', async () => {
      const file = await this.#read()
      const removed = file.sessions.find((session) => session.dshSessionId === dshSessionId)
      if (removed === undefined) return undefined
      await this.#write({
        version: SESSIONS_VERSION,
        sessions: file.sessions.filter((session) => session.dshSessionId !== dshSessionId),
      })
      return removed
    })
  }

  async #read(): Promise<SessionsFile> {
    const file = await readJsonFile<SessionsFile>(this.#path, { version: SESSIONS_VERSION, sessions: [] })
    if (file.version !== SESSIONS_VERSION || !Array.isArray(file.sessions)) {
      throw new CcwError('state-invalid', `${this.#path} has an unsupported format`, { path: this.#path })
    }
    return file
  }

  async #write(file: SessionsFile): Promise<void> {
    await atomicWriteJson(this.#path, file)
  }
}
