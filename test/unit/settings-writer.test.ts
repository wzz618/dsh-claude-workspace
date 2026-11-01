import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsWriter, settingsTargetPath } from '../../src/gate/settings-writer.ts'
import { LocalHost } from '../../src/host/local.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

async function withWriter(run: (writer: SettingsWriter, host: LocalHost, dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await makeTempDir()
  try {
    await run(new SettingsWriter(dataDir), new LocalHost('local'), dataDir)
  } finally {
    await removeTempDir(dataDir)
  }
}

test('a missing settings file is created with the rule', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'project', '.claude', 'settings.local.json')
    const result = await writer.ensureAllowed(host, file, ['Bash(npm test:*)'])
    assert.equal(result.changed, true)
    const document = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(document, { permissions: { allow: ['Bash(npm test:*)'] } })
  })
})

test('existing keys and order survive and duplicates are skipped', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'settings.json')
    await writeFile(file, JSON.stringify({ permissions: { deny: ['x'], allow: ['Read(**)'] }, model: 'opus' }, null, 2))
    const result = await writer.ensureAllowed(host, file, ['Read(**)', 'Bash(ls)'])
    assert.deepEqual(result.added, ['Bash(ls)'])
    const text = await readFile(file, 'utf8')
    assert.ok(text.indexOf('"deny"') < text.indexOf('"allow"'))
    assert.ok(text.indexOf('"model"') > text.indexOf('"allow"'))
    const document = JSON.parse(text)
    assert.deepEqual(document.permissions.allow, ['Read(**)', 'Bash(ls)'])
    assert.deepEqual(document.permissions.deny, ['x'])
    assert.equal(document.model, 'opus')
  })
})

test('invalid JSON is refused and the file is untouched', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'settings.json')
    const original = '{ "permissions": { "allow": [] }, // comment\n}'
    await writeFile(file, original)
    await assert.rejects(writer.ensureAllowed(host, file, ['Bash(ls)']), /not valid JSON/)
    assert.equal(await readFile(file, 'utf8'), original)
  })
})

test('a non-array permissions.allow is refused', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'settings.json')
    const original = JSON.stringify({ permissions: { allow: 'Bash(ls)' } })
    await writeFile(file, original)
    await assert.rejects(writer.ensureAllowed(host, file, ['Read(**)']), /array of strings/)
    assert.equal(await readFile(file, 'utf8'), original)
  })
})

test('replacement leaves a .bak copy of the previous file', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'settings.json')
    await writeFile(file, JSON.stringify({ permissions: { allow: [] } }))
    await writer.ensureAllowed(host, file, ['Bash(ls)'])
    const backup = JSON.parse(await readFile(`${file}.bak`, 'utf8'))
    assert.deepEqual(backup, { permissions: { allow: [] } })
  })
})

test('CCW-written rules can be listed and revoked', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'settings.json')
    await writer.ensureAllowed(host, file, ['Bash(ls)', 'Read(**)'], { tool: 'Bash', sessionId: 's1' })
    const rules = await writer.listWrittenRules()
    assert.equal(rules.length, 2)
    await writer.revoke(host, rules[0]!.id)
    const document = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(document.permissions.allow, ['Read(**)'])
    assert.equal((await writer.listWrittenRules()).length, 1)
  })
})

test('concurrent appends are serialized and both land', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'settings.json')
    await Promise.all([
      writer.ensureAllowed(host, file, ['Bash(one)']),
      writer.ensureAllowed(host, file, ['Bash(two)']),
    ])
    const document = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual([...document.permissions.allow].sort(), ['Bash(one)', 'Bash(two)'])
  })
})

test('settingsTargetPath chooses project and user files', () => {
  assert.equal(
    settingsTargetPath('/work', 'project', '/home/u'),
    '/work/.claude/settings.local.json',
  )
  assert.equal(settingsTargetPath('/work', 'user', '/home/u'), '/home/u/.claude/settings.json')
})

test('a missing file and no rules makes no change and creates nothing', async () => {
  await withWriter(async (writer, host, dataDir) => {
    const file = join(dataDir, 'new', 'settings.json')
    const result = await writer.ensureAllowed(host, file, [])
    assert.equal(result.changed, false)
    assert.equal(existsSync(file), false)
  })
})
