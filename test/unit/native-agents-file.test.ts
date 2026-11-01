import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfig, type CcwConfigInput } from '../../src/config.ts'
import { seedNativeAgent } from '../../src/native/agents-file.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

async function configFor(dir: string, input: CcwConfigInput = {}) {
  await mkdir(join(dir, 'dsh-acp'), { recursive: true })
  return resolveConfig({
    dataDir: dir,
    native: { agentsFile: join(dir, 'dsh-acp', 'agents.json') },
    ...input,
  })
}

test('seeds the local host into a missing agents file', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir, {
      hosts: { local: { kind: 'local', executable: '/opt/acp/claude-agent-acp', args: ['--stdio'], env: { FOO: 'bar' } } },
    })
    const result = seedNativeAgent(config)
    assert.equal(result.status, 'created')
    const written = JSON.parse(await readFile(config.native.agentsFile, 'utf8')) as {
      agents: Record<string, { name: string; command: string; args: string[]; env: Record<string, string> }>
    }
    assert.deepEqual(written.agents['claude-code'], {
      name: 'Claude Code',
      command: '/opt/acp/claude-agent-acp',
      args: ['--stdio'],
      env: { FOO: 'bar' },
    })
    assert.equal((await stat(config.native.agentsFile)).mode & 0o777, 0o600)
  } finally {
    await removeTempDir(dir)
  }
})

test('preserves other agents and an existing entry', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir)
    await writeFile(config.native.agentsFile, JSON.stringify({
      agents: { 'claude-code': { name: 'Manual', command: '/manual/acp' } },
      extra: { keep: true },
    }))
    assert.equal(seedNativeAgent(config).status, 'present')
    const written = JSON.parse(await readFile(config.native.agentsFile, 'utf8')) as {
      agents: Record<string, { name: string }>
      extra?: { keep?: boolean }
    }
    assert.equal(written.agents['claude-code']!.name, 'Manual')
    assert.deepEqual(written.extra, { keep: true })
  } finally {
    await removeTempDir(dir)
  }
})

test('adds a second agent without dropping the first', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir)
    await writeFile(config.native.agentsFile, JSON.stringify({ agents: { other: { name: 'Other', command: 'other' } } }))
    assert.equal(seedNativeAgent(config).status, 'created')
    const written = JSON.parse(await readFile(config.native.agentsFile, 'utf8')) as { agents: Record<string, unknown> }
    assert.deepEqual(Object.keys(written.agents).sort(), ['claude-code', 'other'])
  } finally {
    await removeTempDir(dir)
  }
})

test('invalid JSON fails without touching the file', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir)
    await writeFile(config.native.agentsFile, '{not json')
    const result = seedNativeAgent(config)
    assert.equal(result.status, 'failed')
    assert.match(result.reason ?? '', /could not read|JSON/)
    assert.equal(await readFile(config.native.agentsFile, 'utf8'), '{not json')
  } finally {
    await removeTempDir(dir)
  }
})

test('seeding can be disabled or skipped for a non-acp provider', async () => {
  const dir = await makeTempDir()
  try {
    const disabled = await configFor(dir, { native: { seedAgentsFile: false, agentsFile: join(dir, 'a.json') } })
    assert.equal(seedNativeAgent(disabled).status, 'skipped')
    const nativeProvider = await configFor(dir, { native: { provider: 'opencode-go', agentsFile: join(dir, 'b.json') } })
    const skipped = seedNativeAgent(nativeProvider)
    assert.equal(skipped.status, 'skipped')
    assert.match(skipped.reason ?? '', /not an acp-\* route/)
  } finally {
    await removeTempDir(dir)
  }
})
