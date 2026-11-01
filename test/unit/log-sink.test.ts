import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RollingLogSink } from '../../src/util/log-sink.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

test('rotates to .1 and keeps the configured number of files', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'nested', 'workspace.log')
    const sink = new RollingLogSink(path, { maxBytes: 10, files: 2 })
    await sink.append('first-chunk')
    await sink.append('second-chunk')
    await sink.append('third-chunk')
    assert.equal(await readFile(path, 'utf8'), 'third-chunk')
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'second-chunk')
    await assert.rejects(readFile(`${path}.2`, 'utf8'))
  } finally {
    await removeTempDir(dir)
  }
})

test('files=1 keeps only the active file', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'only.log')
    const sink = new RollingLogSink(path, { maxBytes: 5, files: 1 })
    await sink.append('aaaa')
    await sink.append('bbbb')
    assert.equal(await readFile(path, 'utf8'), 'bbbb')
    await assert.rejects(readFile(`${path}.1`, 'utf8'))
  } finally {
    await removeTempDir(dir)
  }
})

test('a single oversized chunk is written rather than looping rotation', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'large.log')
    const sink = new RollingLogSink(path, { maxBytes: 4, files: 2 })
    await sink.append('oversized-chunk')
    assert.equal(await readFile(path, 'utf8'), 'oversized-chunk')
  } finally {
    await removeTempDir(dir)
  }
})
