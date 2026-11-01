import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRemoteCwdMap, removeRemoteCwd, writeRemoteCwd } from '../../src/native/cwd-map.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

test('writes, updates, and removes per-session remote cwds', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'native-cwd.json')
    writeRemoteCwd(path, 'session-a', '/srv/a')
    writeRemoteCwd(path, 'session-b', '/srv/b')
    assert.deepEqual(readRemoteCwdMap(path).sessions, { 'session-a': '/srv/a', 'session-b': '/srv/b' })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    removeRemoteCwd(path, 'session-a')
    assert.deepEqual(readRemoteCwdMap(path).sessions, { 'session-b': '/srv/b' })
    removeRemoteCwd(path, 'missing')
    assert.deepEqual(readRemoteCwdMap(path).sessions, { 'session-b': '/srv/b' })
  } finally {
    await removeTempDir(dir)
  }
})

test('a corrupt map reads as empty and is replaced on the next write', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'native-cwd.json')
    await mkdir(dir, { recursive: true })
    await writeFile(path, '{not json')
    assert.deepEqual(readRemoteCwdMap(path), { version: 1, sessions: {} })
    writeRemoteCwd(path, 'session-a', '/srv/a')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      version: 1,
      sessions: { 'session-a': '/srv/a' },
    })
  } finally {
    await removeTempDir(dir)
  }
})
