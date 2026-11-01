import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createService } from '../../src/service.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

test('lists the workspace directory and refuses directories outside it', async () => {
  const dataDir = await makeTempDir()
  const service = createService({
    config: {
      dataDir,
      hosts: { local: { kind: 'local' } },
      workspaces: { baseDir: join(dataDir, 'workspaces') },
    },
  })
  try {
    const created = await service.createWorkspace({ hostId: 'local', title: 'Files' })
    const dir = created.workspace.dir
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'a.txt'), 'a')
    const listed = await service.listWorkspaceDirectory(created.workspace.id)
    assert.equal(listed.dir, dir)
    assert.deepEqual(listed.entries.map((entry) => entry.name), ['src', 'a.txt'])
    assert.equal(listed.entries[0]!.isDirectory, true)

    const nested = await service.listWorkspaceDirectory(created.workspace.id, { dir: join(dir, 'src') })
    assert.equal(nested.dir, join(dir, 'src'))

    await assert.rejects(
      service.listWorkspaceDirectory(created.workspace.id, { dir: '/' }),
      /outside workspace/,
    )
    await assert.rejects(
      service.listWorkspaceDirectory(created.workspace.id, { dir: join(created.workspace.baseDir, 'sibling') }),
      /outside workspace/,
    )
    await assert.rejects(
      service.listWorkspaceDirectory(created.workspace.id, { dir: 'relative/path' }),
      /must be absolute/,
    )
  } finally {
    await service.close()
    await removeTempDir(dataDir)
  }
})
