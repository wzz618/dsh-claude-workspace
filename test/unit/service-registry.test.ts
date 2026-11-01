import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createService } from '../../src/service.ts'
import type { WorkspaceControllerLike } from '../../src/workspace/registry.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

function fakeController(): WorkspaceControllerLike & { registrations: Map<string, { path: string; title: string }> } {
  const registrations = new Map<string, { path: string; title: string }>()
  let counter = 0
  return {
    registrations,
    async create(request) {
      const id = `dsh_${(counter += 1)}`
      registrations.set(id, { path: request.path, title: request.path })
      return { workspace: { workspaceId: id, title: request.path } }
    },
    async rename(request) {
      const entry = registrations.get(request.workspaceId)
      if (entry !== undefined) entry.title = request.title
      return { workspace: { workspaceId: request.workspaceId, title: request.title } }
    },
    async delete(request) {
      registrations.delete(request.workspaceId)
      return { deleted: true }
    },
  }
}

test('attaching a late workspace controller registers existing workspaces', async () => {
  const dataDir = await makeTempDir()
  const service = createService({
    config: {
      dataDir,
      hosts: { local: { kind: 'local' } },
      workspaces: { baseDir: join(dataDir, 'workspaces') },
    },
  })
  try {
    assert.equal(service.registryAvailable, false)
    const created = await service.createWorkspace({ hostId: 'local', title: 'Late' })
    assert.equal(created.workspace.dshWorkspaceId, undefined)
    assert.equal(created.warnings.some((warning) => warning.includes('no DSH workspace controller')), true)

    const controller = fakeController()
    await service.attachWorkspaceController(controller)
    assert.equal(service.registryAvailable, true)
    assert.equal(controller.registrations.size, 1)
    const [stored] = await service.listWorkspaces()
    assert.equal(stored!.dshWorkspaceId, 'dsh_1')
    assert.equal(controller.registrations.get('dsh_1')!.title, 'Late')
  } finally {
    await service.close()
    await removeTempDir(dataDir)
  }
})

test('attaching twice does not register the same workspace again', async () => {
  const dataDir = await makeTempDir()
  const service = createService({
    config: {
      dataDir,
      hosts: { local: { kind: 'local' } },
      workspaces: { baseDir: join(dataDir, 'workspaces') },
    },
  })
  try {
    await service.createWorkspace({ hostId: 'local', title: 'Once' })
    const controller = fakeController()
    await service.attachWorkspaceController(controller)
    await service.attachWorkspaceController(controller)
    assert.equal(controller.registrations.size, 1)
  } finally {
    await service.close()
    await removeTempDir(dataDir)
  }
})
