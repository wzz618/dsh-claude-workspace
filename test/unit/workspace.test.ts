import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../../src/config.ts'
import { createHostOps } from '../../src/host/index.ts'
import {
  createWorkspace,
  deleteWorkspaceDirectory,
  deriveSessionDirectory,
  ensureSessionDirectory,
  isSubpath,
  removeWorkspace,
} from '../../src/workspace/lifecycle.ts'
import type { WorkspaceRegistry, WorkspaceRegistration } from '../../src/workspace/registry.ts'
import { SessionStore, WorkspaceStore } from '../../src/workspace/store.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

class FakeRegistry implements WorkspaceRegistry {
  readonly available = true
  readonly registrations = new Map<string, { path: string; title: string }>()
  #counter = 0

  async register(input: { path: string; title: string }): Promise<WorkspaceRegistration> {
    const id = `dsh_${(this.#counter += 1)}`
    this.registrations.set(id, { ...input })
    return { id }
  }

  async rename(id: string, title: string): Promise<void> {
    const entry = this.registrations.get(id)
    if (entry === undefined) throw new Error('missing registration')
    entry.title = title
  }

  async remove(id: string): Promise<void> {
    this.registrations.delete(id)
  }
}

class FailingRegistry implements WorkspaceRegistry {
  readonly available = true
  async register(): Promise<WorkspaceRegistration> {
    throw new Error('registry offline')
  }
  async rename(): Promise<void> {}
  async remove(): Promise<void> {}
}

async function setup(options: { registry?: WorkspaceRegistry } = {}) {
  const dataDir = await makeTempDir()
  const config = resolveConfig({
    dataDir,
    hosts: { local: { kind: 'local' } },
    workspaces: { baseDir: join(dataDir, 'workspaces'), strategy: 'per-workspace', prefix: 'cc-' },
  })
  const workspaces = new WorkspaceStore(dataDir)
  const sessions = new SessionStore(dataDir)
  const registry = options.registry ?? new FakeRegistry()
  const host = (hostId: string) => createHostOps(hostId, config.hosts[hostId]!, config.ssh)
  return {
    dataDir,
    config,
    workspaces,
    sessions,
    registry,
    deps: { config, workspaces, registry, host },
    cleanup: () => removeTempDir(dataDir),
  }
}

test('creates a derived workspace directory, registers it, and persists the record', async () => {
  const context = await setup()
  try {
    const result = await createWorkspace(context.deps, { hostId: 'local' })
    assert.equal(result.created, true)
    assert.equal(result.warnings.length, 0)
    assert.equal(result.workspace.hostId, 'local')
    assert.deepEqual(result.workspace.host, { kind: 'local' })
    assert.equal(result.workspace.derived, true)
    assert.ok(existsSync(result.workspace.dir))
    assert.ok(result.workspace.dir.startsWith(join(context.dataDir, 'workspaces')))
    assert.equal(result.workspace.dshWorkspaceId, 'dsh_1')
    assert.equal((await context.workspaces.list()).length, 1)
  } finally {
    await context.cleanup()
  }
})

test('adopts an existing explicit directory without deriving one', async () => {
  const context = await setup()
  try {
    const dir = join(context.dataDir, 'my-project')
    const result = await createWorkspace(context.deps, { hostId: 'local', dir, title: 'Project' })
    assert.equal(result.created, true)
    assert.equal(result.workspace.title, 'Project')
    assert.equal(result.workspace.derived, false)
    assert.ok(existsSync(dir))
  } finally {
    await context.cleanup()
  }
})

test('re-adding the same directory resolves the existing workspace', async () => {
  const context = await setup()
  try {
    const first = await createWorkspace(context.deps, { hostId: 'local' })
    const second = await createWorkspace(context.deps, { hostId: 'local', dir: first.workspace.dir })
    assert.equal(second.created, false)
    assert.equal(second.workspace.id, first.workspace.id)
    assert.match(second.warnings[0]!, /already managed/)
  } finally {
    await context.cleanup()
  }
})

test('a registration failure writes no record and keeps the directory', async () => {
  const context = await setup({ registry: new FailingRegistry() })
  try {
    await assert.rejects(createWorkspace(context.deps, { hostId: 'local' }), /registry offline/)
    assert.equal((await context.workspaces.list()).length, 0)
    const entries = await readdir(join(context.dataDir, 'workspaces'))
    assert.equal(entries.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('removal marks the record and removes only the DSH registration', async () => {
  const context = await setup()
  try {
    const created = await createWorkspace(context.deps, { hostId: 'local' })
    const removed = await removeWorkspace(context.deps, created.workspace.id)
    assert.equal(removed.state, 'removed')
    assert.equal(context.registry instanceof FakeRegistry ? context.registry.registrations.size : -1, 0)
    assert.ok(existsSync(created.workspace.dir))
    await assert.rejects(removeWorkspace(context.deps, created.workspace.id), /does not exist/)
  } finally {
    await context.cleanup()
  }
})

test('directory deletion is refused for active, user-supplied, or unconfirmed workspaces', async () => {
  const context = await setup()
  try {
    const derived = await createWorkspace(context.deps, { hostId: 'local' })
    await assert.rejects(
      deleteWorkspaceDirectory(context.deps, derived.workspace.id, { deleteDirectory: true }),
      /remove the workspace from DSH/,
    )
    await assert.rejects(
      deleteWorkspaceDirectory(context.deps, derived.workspace.id, { deleteDirectory: false }),
      /requires deleteDirectory: true/,
    )
    await removeWorkspace(context.deps, derived.workspace.id)
    await deleteWorkspaceDirectory(context.deps, derived.workspace.id, { deleteDirectory: true })
    assert.equal(existsSync(derived.workspace.dir), false)

    const external = await createWorkspace(context.deps, {
      hostId: 'local',
      dir: join(context.dataDir, 'outside'),
    })
    await removeWorkspace(context.deps, external.workspace.id)
    await assert.rejects(
      deleteWorkspaceDirectory(context.deps, external.workspace.id, { deleteDirectory: true }),
      /refusing to delete/,
    )
    assert.ok(existsSync(external.workspace.dir))
  } finally {
    await context.cleanup()
  }
})

test('per-session derivation is unique and created on demand', async () => {
  const context = await setup()
  try {
    const created = await createWorkspace(context.deps, { hostId: 'local', strategy: 'per-session' })
    const one = deriveSessionDirectory(context.deps, created.workspace, { dshSessionId: 's1', createdAt: 1 })
    const two = deriveSessionDirectory(context.deps, created.workspace, { dshSessionId: 's2', createdAt: 2 })
    assert.notEqual(one, two)
    assert.ok(isSubpath(created.workspace.baseDir, one))
    await ensureSessionDirectory(context.deps.host('local'), created.workspace, one)
    assert.ok(existsSync(one))
    assert.notEqual(one, created.workspace.dir)
  } finally {
    await context.cleanup()
  }
})

test('per-workspace derivation returns the workspace directory itself', async () => {
  const context = await setup()
  try {
    const created = await createWorkspace(context.deps, { hostId: 'local' })
    assert.equal(
      deriveSessionDirectory(context.deps, created.workspace, { dshSessionId: 's1', createdAt: 1 }),
      created.workspace.dir,
    )
  } finally {
    await context.cleanup()
  }
})

test('isSubpath respects path segment boundaries', () => {
  assert.equal(isSubpath('/a/b', '/a/b/c'), true)
  assert.equal(isSubpath('/a/b', '/a/b'), true)
  assert.equal(isSubpath('/a/b', '/a/bc'), false)
  assert.equal(isSubpath('/a/b/', '/a/b/c'), true)
})

test('session bindings persist and are found by ACP id', async () => {
  const context = await setup()
  try {
    await context.sessions.upsert({
      dshSessionId: 's1',
      workspaceId: 'ws_1',
      acpSessionId: 'acp_1',
      cwd: '/w',
      createdAt: 1,
      lastEventSeq: 0,
      needsLoad: false,
    })
    assert.equal((await context.sessions.get('s1'))!.acpSessionId, 'acp_1')
    assert.equal((await context.sessions.findByAcpSessionId('acp_1'))!.dshSessionId, 's1')
    await context.sessions.update('s1', { lastEventSeq: 5, needsLoad: true })
    assert.equal((await context.sessions.get('s1'))!.lastEventSeq, 5)
    assert.equal((await context.sessions.remove('s1'))!.dshSessionId, 's1')
    assert.equal(await context.sessions.get('s1'), undefined)
  } finally {
    await context.cleanup()
  }
})
