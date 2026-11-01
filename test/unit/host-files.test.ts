import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalHost } from '../../src/host/local.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

test('listDirectory sorts directories first and honours the limit', async () => {
  const dir = await makeTempDir()
  try {
    await mkdir(join(dir, 'zeta'))
    await mkdir(join(dir, 'alpha'))
    await writeFile(join(dir, 'b.txt'), 'b')
    await writeFile(join(dir, 'a.txt'), 'a')
    const host = new LocalHost('local')
    const entries = await host.listDirectory(dir)
    assert.deepEqual(entries.map((entry) => entry.name), ['alpha', 'zeta', 'a.txt', 'b.txt'])
    assert.equal(entries[0]!.isDirectory, true)
    assert.equal(entries[2]!.path, join(dir, 'a.txt'))
    const limited = await host.listDirectory(dir, 2)
    assert.equal(limited.length, 2)
  } finally {
    await removeTempDir(dir)
  }
})

test('listDirectory reports a missing directory', async () => {
  const host = new LocalHost('local')
  await assert.rejects(host.listDirectory('/definitely/missing/ccw'), /does not exist/)
})
