import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { resolveConfig, type CcwConfigInput } from '../../src/config.ts'
import { NativeSessionBridge, type NativeAgents, type NativeSessionInput } from '../../src/native/bridge.ts'
import { createService } from '../../src/service.ts'
import { CcwError } from '../../src/util/errors.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

function nativeConfig(input: CcwConfigInput['native'] = {}) {
  return resolveConfig({ native: input }).native
}

function lookup(services: Record<string, unknown>): { get(serviceName: string): unknown } {
  return { get: (serviceName) => services[serviceName] }
}

interface CreateCall {
  readonly sessionId: string
  readonly meta?: { readonly cwd?: string }
  readonly agentOptions?: { readonly provider: string; readonly model?: string }
}

function fakeAgents(): NativeAgents & { readonly calls: CreateCall[] } {
  const calls: CreateCall[] = []
  return {
    calls,
    async create(options) {
      calls.push(options)
      return { agent: { id: options.sessionId, session: { id: options.sessionId } } }
    },
  }
}

function fakeWorkspaceRegistry(): {
  readonly attached: string[]
  get(workspaceId: string): { attachSession(sessionId: string): Promise<void> } | undefined
} {
  const attached: string[] = []
  return {
    attached,
    get(workspaceId) {
      if (workspaceId !== 'dsh-workspace') return undefined
      return {
        async attachSession(sessionId) {
          attached.push(sessionId)
        },
      }
    },
  }
}

function fakePresets(): {
  readonly applied: { session: unknown; name: string }[]
  readonly names: string[]
  set(session: unknown, name: string): void
} {
  const applied: { session: unknown; name: string }[] = []
  return {
    applied,
    names: ['workspace-write', 'danger-full-access'],
    set(session, name) {
      if (!this.names.includes(name)) throw new Error(`unknown preset "${name}"`)
      applied.push({ session, name })
    },
  }
}

const INPUT: NativeSessionInput = { cwd: '/work/demo', dshWorkspaceId: 'dsh-workspace' }

test('native session uses the configured ACP provider, attaches to the workspace, and pins permissions', async () => {
  const agents = fakeAgents()
  const registry = fakeWorkspaceRegistry()
  const presets = fakePresets()
  const bridge = new NativeSessionBridge(
    lookup({ agents, workspaceRegistry: registry, permissionPresets: presets }),
    nativeConfig(),
    () => 'session-fixed',
  )

  const result = await bridge.create(INPUT)

  assert.deepEqual(result, {
    sessionId: 'session-fixed',
    workspaceAttached: true,
    permissionPreset: 'danger-full-access',
    warnings: [],
  })
  assert.deepEqual(agents.calls, [{
    sessionId: 'session-fixed',
    meta: { cwd: '/work/demo' },
    agentOptions: { provider: 'acp-claude-code', model: 'default' },
  }])
  assert.deepEqual(registry.attached, ['session-fixed'])
  assert.equal(presets.applied.length, 1)
  assert.equal(presets.applied[0]!.name, 'danger-full-access')
})

test('native session honours provider, model, and preset overrides', async () => {
  const agents = fakeAgents()
  const presets = fakePresets()
  const bridge = new NativeSessionBridge(
    lookup({ agents, workspaceRegistry: fakeWorkspaceRegistry(), permissionPresets: presets }),
    nativeConfig({ provider: 'acp-other', model: 'sonnet', permissionPreset: 'workspace-write' }),
    () => 'session-quiet',
  )

  const result = await bridge.create(INPUT)

  assert.equal(result.permissionPreset, 'workspace-write')
  assert.deepEqual(agents.calls[0]!.agentOptions, { provider: 'acp-other', model: 'sonnet' })
  assert.equal(presets.applied[0]!.name, 'workspace-write')
})

test('an unknown permission preset is a warning, not a creation failure', async () => {
  const bridge = new NativeSessionBridge(
    lookup({ agents: fakeAgents(), workspaceRegistry: fakeWorkspaceRegistry(), permissionPresets: fakePresets() }),
    nativeConfig({ permissionPreset: 'full-access' }),
    () => 'session-warning',
  )

  const result = await bridge.create(INPUT)

  assert.equal(result.sessionId, 'session-warning')
  assert.equal(result.workspaceAttached, true)
  assert.equal(result.permissionPreset, undefined)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /full-access/)
  assert.match(result.warnings[0]!, /workspace-write, danger-full-access/)
})

test('a missing permission-preset service leaves the session usable with a warning', async () => {
  const bridge = new NativeSessionBridge(
    lookup({ agents: fakeAgents(), workspaceRegistry: fakeWorkspaceRegistry() }),
    nativeConfig(),
    () => 'session-no-presets',
  )

  const result = await bridge.create(INPUT)

  assert.equal(result.permissionPreset, undefined)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /Full access/)
})

test('an attach failure keeps the created session and reports it', async () => {
  const agents = fakeAgents()
  const bridge = new NativeSessionBridge(
    lookup({
      agents,
      workspaceRegistry: {
        get: () => ({
          async attachSession() {
            throw new Error('workspace is archived')
          },
        }),
      },
      permissionPresets: fakePresets(),
    }),
    nativeConfig(),
    () => 'session-orphan',
  )

  const result = await bridge.create(INPUT)

  assert.equal(result.sessionId, 'session-orphan')
  assert.equal(result.workspaceAttached, false)
  assert.match(result.warnings[0]!, /workspace is archived/)
})

test('a missing DSH workspace keeps the session but warns that the sidebar will not show it', async () => {
  const bridge = new NativeSessionBridge(
    lookup({
      agents: fakeAgents(),
      workspaceRegistry: { get: () => undefined },
      permissionPresets: fakePresets(),
    }),
    nativeConfig(),
    () => 'session-gone',
  )

  const result = await bridge.create(INPUT)

  assert.equal(result.workspaceAttached, false)
  assert.match(result.warnings[0]!, /dsh-workspace is gone/)
})

test('native creation refuses a CCW workspace without a DSH workspace id', async () => {
  const agents = fakeAgents()
  const bridge = new NativeSessionBridge(
    lookup({ agents, workspaceRegistry: fakeWorkspaceRegistry(), permissionPresets: fakePresets() }),
    nativeConfig(),
    () => 'session-unregistered',
  )

  await assert.rejects(
    bridge.create({ cwd: '/work/demo' }),
    (error: unknown) => error instanceof CcwError
      && error.code === 'workspace-registration-failed'
      && /would not appear in the sidebar/.test(error.message),
  )
  assert.equal(agents.calls.length, 0)
})

test('native creation without the DSH Agent service fails with a configuration code', async () => {
  const bridge = new NativeSessionBridge(lookup({}), nativeConfig(), () => 'session-none')

  await assert.rejects(
    bridge.create(INPUT),
    (error: unknown) => error instanceof CcwError && error.code === 'native-unavailable',
  )
  assert.equal(bridge.available, false)
})

test('a rejected DSH creation is reported as a native-session failure with guidance', async () => {
  const bridge = new NativeSessionBridge(
    lookup({
      agents: {
        async create() {
          throw new Error('ACP agent "acp-claude-code" is unavailable')
        },
      },
      workspaceRegistry: fakeWorkspaceRegistry(),
      permissionPresets: fakePresets(),
    }),
    nativeConfig(),
    () => 'session-rejected',
  )

  await assert.rejects(
    bridge.create(INPUT),
    (error: unknown) => error instanceof CcwError
      && error.code === 'native-session-failed'
      && /ACP agent "acp-claude-code" is unavailable/.test(error.message)
      && /Install the ACP adapter/.test(error.message),
  )
})

test('attachToWorkspace=false skips the workspace registry', async () => {
  const agents = fakeAgents()
  const bridge = new NativeSessionBridge(
    lookup({ agents, permissionPresets: fakePresets() }),
    nativeConfig({ attachToWorkspace: false }),
    () => 'session-standalone',
  )

  const result = await bridge.create({ cwd: '/work/demo' })

  assert.equal(result.workspaceAttached, false)
  assert.deepEqual(result.warnings, [])
  assert.equal(agents.calls.length, 1)
})

test('service-level entry registers the workspace, then creates a native session', async () => {
  const dataDir = await makeTempDir()
  const agents = fakeAgents()
  const presets = fakePresets()
  const attached: string[] = []
  const service = createService({
    config: { dataDir, hosts: { local: { kind: 'local' } } },
    workspaceController: {
      async create() {
        return { workspace: { workspaceId: 'dsh-workspace', title: '' } }
      },
      async rename() {},
      async delete() {},
    },
    services: lookup({
      agents,
      permissionPresets: presets,
      workspaceRegistry: {
        get: (workspaceId: string) => workspaceId === 'dsh-workspace'
          ? { attachSession: async (sessionId: string) => { attached.push(sessionId) } }
          : undefined,
      },
    }),
    newId: () => 'ws_fixed',
  })
  try {
    const created = await service.createWorkspace({ hostId: 'local', title: 'Demo', dir: joinTemp(dataDir) })
    assert.equal(service.nativeAvailable, true)

    const result = await service.createNativeSession(created.workspace.id)

    assert.equal(result.sessionId.startsWith('session-'), true)
    assert.equal(result.workspaceAttached, true)
    assert.deepEqual(attached, [result.sessionId])
    assert.equal(agents.calls[0]!.meta!.cwd, created.workspace.dir)
  } finally {
    await service.close()
    await removeTempDir(dataDir)
  }
})

const stubSshHost = {
  id: 'remote',
  kind: 'ssh' as const,
  async stat() {
    return { exists: true, isDirectory: true }
  },
  async mkdirp() {},
  async realpath(path: string) {
    return path
  },
  async listDirectory() {
    return []
  },
  async readText() {
    return undefined
  },
  async writeTextAtomic() {},
  async removeFile() {},
  async home() {
    return '/home/ubuntu'
  },
  async probe() {
    return { found: true }
  },
  async exec() {
    return { code: 0, signal: null, stdout: '', stderr: '' }
  },
  async spawn() {
    throw new Error('unused')
  },
  async spawnAcp() {
    throw new Error('unused')
  },
}

test('a remote workspace without probeCwd fails with actionable configuration guidance', async () => {
  const dataDir = await makeTempDir()
  const service = createService({
    config: {
      dataDir,
      hosts: {
        local: { kind: 'local' },
        remote: { kind: 'ssh', alias: 'remote' },
      },
    },
    hostFactory: () => stubSshHost,
    services: lookup({}),
  })
  try {
    const created = await service.createWorkspace({ hostId: 'remote', title: 'Remote', dir: '/srv/demo' })
    await assert.rejects(
      service.createNativeSession(created.workspace.id),
      (error: unknown) => error instanceof CcwError
        && error.code === 'config-invalid'
        && /probeCwd/.test(error.message),
    )
  } finally {
    await service.close()
    await removeTempDir(dataDir)
  }
})

test('a remote workspace with probeCwd creates a native session on its host provider', async () => {
  const dataDir = await makeTempDir()
  const agents = fakeAgents()
  const presets = fakePresets()
  const service = createService({
    config: {
      dataDir,
      hosts: {
        local: { kind: 'local' },
        devbox: { kind: 'ssh', alias: 'devbox', probeCwd: '/home/dev/project' },
      },
      native: { attachToWorkspace: false, cwdMapFile: join(dataDir, 'dsh-acp', 'native-cwd.json') },
    },
    hostFactory: () => stubSshHost,
    services: lookup({ agents, permissionPresets: presets }),
    newId: () => 'ws_remote',
  })
  try {
    const created = await service.createWorkspace({ hostId: 'devbox', title: 'Remote', dir: '/srv/demo' })
    const result = await service.createNativeSession(created.workspace.id)
    assert.equal(result.sessionId.startsWith('session-'), true)
    assert.equal(agents.calls.length, 1)
    assert.deepEqual(agents.calls[0]!.agentOptions, { provider: 'acp-claude-code-devbox', model: 'default' })
    assert.equal(agents.calls[0]!.meta!.cwd, join(dataDir, 'remote-workspaces', 'ws_remote'))
    const cwdMap = JSON.parse(await readFile(join(dataDir, 'dsh-acp', 'native-cwd.json'), 'utf8')) as {
      sessions: Record<string, string>
    }
    assert.deepEqual(cwdMap.sessions, { [result.sessionId]: '/srv/demo' })
  } finally {
    await service.close()
    await removeTempDir(dataDir)
  }
})

function joinTemp(dataDir: string): string {
  return `${dataDir}/demo`
}
