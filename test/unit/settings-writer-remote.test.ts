import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsWriter } from '../../src/gate/settings-writer.ts'
import type { AtomicFileOptions, ExecResult, HostOps, HostProcess, PathInfo, ProbeResult } from '../../src/host/types.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

interface StoredFile {
  content: string
  mode: number
}

/** In-memory host used to exercise the remote writer without ssh. */
class MemoryHost implements HostOps {
  readonly id: string
  readonly kind = 'ssh' as const
  readonly files = new Map<string, StoredFile>()
  readonly backups = new Map<string, string>()
  homePath = '/home/remote'

  constructor(id = 'target') {
    this.id = id
  }

  async stat(path: string): Promise<PathInfo> {
    return { exists: this.files.has(path), isDirectory: false }
  }

  async mkdirp(): Promise<void> {}

  async realpath(path: string): Promise<string> {
    return path
  }

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path)?.content
  }

  async writeTextAtomic(path: string, content: string, options: AtomicFileOptions = {}): Promise<void> {
    const previous = this.files.get(path)
    if (options.backup === true && previous !== undefined) this.backups.set(path, previous.content)
    this.files.set(path, { content, mode: options.mode ?? 0o600 })
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path)
  }

  async home(): Promise<string> {
    return this.homePath
  }

  async probe(): Promise<ProbeResult> {
    return { found: true }
  }

  async exec(): Promise<ExecResult> {
    throw new Error('not implemented')
  }

  async spawn(): Promise<HostProcess> {
    throw new Error('not implemented')
  }

  async spawnAcp(): Promise<HostProcess> {
    throw new Error('not implemented')
  }
}

async function withWriter(run: (writer: SettingsWriter, host: MemoryHost, dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await makeTempDir()
  try {
    await run(new SettingsWriter(dataDir), new MemoryHost(), dataDir)
  } finally {
    await removeTempDir(dataDir)
  }
}

test('remote rules are written atomically with mode 600 and tracked by host', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = '/srv/project/.claude/settings.local.json'
    const result = await writer.ensureAllowed(host, file, ['Bash(npm test:*)'], { host: 'target', tool: 'Bash' })
    assert.equal(result.changed, true)
    assert.equal(host.files.get(file)!.mode, 0o600)
    const rules = await writer.listWrittenRules()
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.host, 'target')
    assert.equal(rules[0]!.file, file)
    void dataDir
  })
})

test('a second remote write leaves a backup of the previous file', async () => {
  await withWriter(async (writer, host) => {
    const file = '/srv/project/.claude/settings.local.json'
    await writer.ensureAllowed(host, file, ['Bash(one)'], { host: 'target' })
    await writer.ensureAllowed(host, file, ['Bash(two)'], { host: 'target' })
    assert.match(host.backups.get(file)!, /Bash\(one\)/)
    assert.match(host.files.get(file)!.content, /Bash\(two\)/)
  })
})

test('invalid remote JSON is refused without writing', async () => {
  await withWriter(async (writer, host) => {
    const file = '/srv/project/.claude/settings.local.json'
    host.files.set(file, { content: '{ // jsonc\n}', mode: 0o600 })
    await assert.rejects(writer.ensureAllowed(host, file, ['Bash(ls)'], { host: 'target' }), /not valid JSON/)
    assert.equal(host.files.get(file)!.content, '{ // jsonc\n}')
  })
})

test('remote revocation removes only the CCW rule', async () => {
  await withWriter(async (writer, host) => {
    const file = '/srv/project/.claude/settings.local.json'
    host.files.set(file, { content: JSON.stringify({ permissions: { allow: ['Read(**)'] } }), mode: 0o600 })
    await writer.ensureAllowed(host, file, ['Bash(ls)'], { host: 'target' })
    const [entry] = await writer.listWrittenRules()
    await writer.revoke(host, entry!.id)
    const document = JSON.parse(host.files.get(file)!.content)
    assert.deepEqual(document.permissions.allow, ['Read(**)'])
    assert.equal((await writer.listWrittenRules()).length, 0)
  })
})
