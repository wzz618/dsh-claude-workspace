import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuditLog, hashArgs } from '../../src/audit.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

test('append writes one metadata line to the current day', async () => {
  const dir = await makeTempDir()
  try {
    const log = new AuditLog(dir, { retainDays: 30, now: () => new Date('2026-11-01T12:00:00Z') })
    await log.append({ host: 'local', workspace: 'ws_1', session: 's1', kind: 'permission', decision: 'allow_once' })
    const entries = await log.list('2026-11-01')
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.host, 'local')
    assert.equal(entries[0]!.decision, 'allow_once')
    assert.equal(entries[0]!.ts, '2026-11-01T12:00:00.000Z')
  } finally {
    await removeTempDir(dir)
  }
})

test('prune removes files older than the retention window', async () => {
  const dir = await makeTempDir()
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '2026-09-01.jsonl'), '{}\n')
    await writeFile(join(dir, '2026-10-15.jsonl'), '{}\n')
    const log = new AuditLog(dir, { retainDays: 30, now: () => new Date('2026-11-01T00:00:00Z') })
    const removed = await log.prune()
    assert.deepEqual(removed, ['2026-09-01.jsonl'])
    assert.equal(existsSync(join(dir, '2026-09-01.jsonl')), false)
    assert.equal(existsSync(join(dir, '2026-10-15.jsonl')), true)
  } finally {
    await removeTempDir(dir)
  }
})

test('hashArgs digests arguments without retaining them', () => {
  const digest = hashArgs({ command: 'npm test' })
  assert.match(digest ?? '', /^[0-9a-f]{8}$/)
  assert.equal(hashArgs({ command: 'npm test' }), digest)
  assert.notEqual(hashArgs({ command: 'npm run build' }), digest)
  assert.equal(hashArgs(undefined), undefined)
})
