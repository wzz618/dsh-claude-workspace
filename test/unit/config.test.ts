import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { CcwConfigError, compareVersions, expandPath, resolveConfig } from '../../src/config.ts'

test('defaults resolve to a local host and a data directory under DSH_HOME', () => {
  const config = resolveConfig({}, { DSH_HOME: '/tmp/dsh-home' })
  assert.deepEqual(Object.keys(config.hosts), ['local'])
  assert.equal(config.hosts.local!.kind, 'local')
  assert.equal(config.defaultHost, 'local')
  assert.equal(config.dataDir, '/tmp/dsh-home/claude-code')
  assert.equal(config.workspaces.baseDir, '/tmp/dsh-home/claude-code/workspaces')
  assert.equal(config.workspaces.strategy, 'per-workspace')
  assert.equal(config.workspaces.prefix, 'cc-')
  assert.equal(config.approvals.timeoutMs, 0)
  assert.equal(config.acp.executable, 'claude-agent-acp')
  assert.equal(config.permissions.forwardClaudeOptions, true)
  assert.deepEqual(config.native, {
    provider: 'acp-claude-code',
    model: 'default',
    permissionPreset: 'danger-full-access',
    attachToWorkspace: true,
    agentsFile: '/tmp/dsh-home/dsh-acp/agents.json',
    seedAgentsFile: true,
    remoteSpawnCwd: '/tmp',
    sshCommand: 'ssh',
    cwdMapFile: '/tmp/dsh-home/dsh-acp/native-cwd.json',
  })
})

test('native entry configuration is validated', () => {
  const config = resolveConfig({ native: { provider: 'acp-other', model: 'sonnet', permissionPreset: 'workspace-write', attachToWorkspace: false } })
  assert.equal(config.native.provider, 'acp-other')
  assert.equal(config.native.model, 'sonnet')
  assert.equal(config.native.permissionPreset, 'workspace-write')
  assert.equal(config.native.attachToWorkspace, false)
  assert.equal(config.native.agentsFile.endsWith('/dsh-acp/agents.json'), true)
  assert.equal(config.native.seedAgentsFile, true)
  assert.equal(config.native.remoteSpawnCwd.endsWith('/tmp'), true)
  assert.equal(config.native.sshCommand, 'ssh')
  assert.throws(() => resolveConfig({ native: { bogus: true } as never }), /native.bogus/)
  assert.throws(() => resolveConfig({ native: { attachToWorkspace: 'yes' as never } }), /native.attachToWorkspace/)
})

test('unknown keys are rejected together with other invalid fields', () => {
  const input = JSON.parse('{"mystery":1,"workspaces":{"strategy":"nope","prefix":"bad prefix"}}') as Parameters<typeof resolveConfig>[0]
  assert.throws(
    () => resolveConfig(input),
    (error: unknown) => {
      assert.ok(error instanceof CcwConfigError)
      assert.equal(error.issues.length, 3)
      assert.ok(error.issues.some((issue) => issue.includes('config.mystery')))
      assert.ok(error.issues.some((issue) => issue.includes('workspaces.strategy')))
      assert.ok(error.issues.some((issue) => issue.includes('workspaces.prefix')))
      return true
    },
  )
})

test('forwardClaudeOptions cannot be disabled (design decision B5)', () => {
  assert.throws(
    () => resolveConfig({ permissions: { forwardClaudeOptions: false } }),
    (error: unknown) => error instanceof CcwConfigError && error.issues.some((issue) => issue.includes('B5')),
  )
})

test('ssh hosts derive their alias from the map key and require valid ssh options', () => {
  const config = resolveConfig({
    hosts: {
      local: { kind: 'local' },
      devbox: { kind: 'ssh', executable: 'claude-agent-acp', connectTimeoutMs: 5000 },
    },
    defaultHost: 'devbox',
  })
  assert.equal(config.hosts.devbox!.kind, 'ssh')
  assert.equal(config.hosts.devbox!.alias, 'devbox')
  assert.equal(config.hosts.devbox!.connectTimeoutMs, 5000)
  assert.equal(config.defaultHost, 'devbox')
})

test('a default host that is not declared is an error', () => {
  assert.throws(() => resolveConfig({ defaultHost: 'missing' }), /defaultHost "missing"/)
})

test('paths expand DSH_HOME and make relative paths absolute', () => {
  assert.equal(expandPath('${DSH_HOME}/x', { DSH_HOME: '/srv/dsh' }), '/srv/dsh/x')
  const config = resolveConfig({ workspaces: { baseDir: 'relative/dir' } }, { DSH_HOME: '/srv/dsh' })
  assert.equal(config.workspaces.baseDir, join(process.cwd(), 'relative/dir'))
})

test('version comparison follows semver ordering for release components', () => {
  assert.ok(compareVersions('0.99.1', '0.99.0') > 0)
  assert.ok(compareVersions('0.99.1', '1.0.0') < 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') === 0)
})

test('version boundaries must be ordered', () => {
  assert.throws(
    () => resolveConfig({ acp: { minimumVersion: '2.0.0', maximumVersionExclusive: '1.0.0' } }),
    /minimumVersion must be lower/,
  )
})

test('log rotation defaults live under the data directory', () => {
  const config = resolveConfig({}, { DSH_HOME: '/tmp/dsh-home' })
  assert.equal(config.logs.dir, '/tmp/dsh-home/claude-code/logs')
  assert.equal(config.logs.maxBytes, 10 * 1024 * 1024)
  assert.equal(config.logs.files, 3)
  assert.throws(() => resolveConfig({ logs: { files: 11 } }), /logs.files must be 10 or fewer/)
  assert.throws(() => resolveConfig({ logs: { maxBytes: 1 } }), /logs.maxBytes/)
})
