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
      managedBy: 'dsh-claude-workspace',
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

test('an SSH host gets an ssh launcher with cwd substitution and probe directory', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir, {
      hosts: {
        local: { kind: 'local', executable: '/opt/local/acp' },
        devbox: {
          kind: 'ssh',
          alias: 'devbox',
          executable: '/home/dev/bin/claude-agent-acp',
          args: ['--stdio'],
          probeCwd: '/home/dev/project',
        },
      },
    })
    const result = seedNativeAgent(config)
    assert.equal(result.status, 'created')
    assert.deepEqual(result.entries.map((entry) => [entry.id, entry.status]), [
      ['claude-code', 'created'],
      ['claude-code-devbox', 'created'],
    ])
    const written = JSON.parse(await readFile(config.native.agentsFile, 'utf8')) as {
      agents: Record<string, {
        command: string
        args: string[]
        spawnCwd: string
        cwdToken: string
        probeCwd: string
        cwdMapFile: string
      }>
    }
    const remote = written.agents['claude-code-devbox']!
    assert.equal(remote.command, 'ssh')
    assert.equal(remote.spawnCwd, config.native.remoteSpawnCwd)
    assert.equal(remote.cwdToken, '{cwd}')
    assert.equal(remote.probeCwd, '/home/dev/project')
    assert.equal(remote.cwdMapFile, config.native.cwdMapFile)
    assert.ok(remote.args.includes('-T'))
    assert.ok(remote.args.includes('devbox'))
    assert.ok(remote.args.includes('{cwd}'))
    assert.ok(remote.args.includes("'/home/dev/bin/claude-agent-acp'"))
    assert.ok(remote.args.includes("'--stdio'"))
    const script = remote.args.find((arg) => arg.includes('exec'))!
    assert.match(script, /^'cd "\$1" && shift && exec "\$@"'$/)
  } finally {
    await removeTempDir(dir)
  }
})

test('an SSH host without probeCwd is reported instead of seeded', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir, {
      hosts: {
        local: { kind: 'local' },
        devbox: { kind: 'ssh', alias: 'devbox' },
      },
    })
    const result = seedNativeAgent(config)
    assert.equal(result.status, 'partial')
    const remote = result.entries.find((entry) => entry.id === 'claude-code-devbox')!
    assert.equal(remote.status, 'skipped')
    assert.match(remote.reason ?? '', /probeCwd/)
    const written = JSON.parse(await readFile(config.native.agentsFile, 'utf8')) as { agents: Record<string, unknown> }
    assert.equal(Object.hasOwn(written.agents, 'claude-code-devbox'), false)
  } finally {
    await removeTempDir(dir)
  }
})

test('a managed entry is refreshed when host configuration changes', async () => {
  const dir = await makeTempDir()
  try {
    const first = await configFor(dir, {
      hosts: { local: { kind: 'local', executable: '/old/local' } },
    })
    assert.equal(seedNativeAgent(first).status, 'created')
    const second = await configFor(dir, {
      hosts: { local: { kind: 'local', executable: '/new/local' } },
    })
    const result = seedNativeAgent(second)
    assert.equal(result.status, 'updated')
    assert.equal(result.entries.find((entry) => entry.id === 'claude-code')!.status, 'updated')
    const written = JSON.parse(await readFile(second.native.agentsFile, 'utf8')) as {
      agents: Record<string, { command: string }>
    }
    assert.equal(written.agents['claude-code']!.command, '/new/local')
  } finally {
    await removeTempDir(dir)
  }
})

test('a manual entry with the same id is never overwritten', async () => {
  const dir = await makeTempDir()
  try {
    const config = await configFor(dir)
    await writeFile(config.native.agentsFile, JSON.stringify({
      agents: { 'claude-code': { name: 'Mine', command: '/manual' } },
    }))
    assert.equal(seedNativeAgent(config).status, 'present')
    const written = JSON.parse(await readFile(config.native.agentsFile, 'utf8')) as {
      agents: Record<string, { name: string; command: string }>
    }
    assert.equal(written.agents['claude-code']!.command, '/manual')
  } finally {
    await removeTempDir(dir)
  }
})
