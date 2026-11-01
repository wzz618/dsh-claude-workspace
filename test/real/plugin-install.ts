#!/usr/bin/env node
// Verifies that installing and removing the plugin leaves no profile residue.
//
// Required environment:
//   DSH_REPO        deepseek-harness checkout containing the `dsh` CLI
//   CCW_PLUGIN_PATH plugin package path (default: current directory)
//
// The check runs in a temporary DSH_HOME: add -> --dump-config contains the
// row -> remove -> --dump-config no longer contains it and the profile manifest
// no longer lists the dependency or bundle.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

const runFile = promisify(execFile)
const dshRepo = process.env.DSH_REPO ?? '/root/autodl-tmp/code/wangzhengzhuo512/deepseek-harness'
const pluginPath = process.env.CCW_PLUGIN_PATH ?? process.cwd()
const profile = 'ccw-install-check'

function log(message: string): void {
  process.stdout.write(`[plugin-install] ${message}\n`)
}

async function dsh(home: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile('pnpm', ['dsh', ...args], {
    cwd: dshRepo,
    env: { ...process.env, DSH_HOME: home },
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

async function manifest(home: string): Promise<{ dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }> {
  return JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
}

async function main(): Promise<void> {
  const home = await makeTempDir('ccw-install-')
  try {
    log(`repo=${dshRepo} plugin=${pluginPath} home=${home}`)
    await dsh(home, ['plugin', '--profile', profile, 'add', pluginPath])
    const installed = await dsh(home, ['--profile', profile, '--dump-config'])
    assert.match(installed, /id: claude-workspace/)
    const before = await manifest(home)
    assert.equal(typeof before.dependencies?.['dsh-claude-workspace'], 'string')
    assert.ok(before.dsh?.profile?.bundles?.includes('dsh-claude-workspace'))

    await dsh(home, ['plugin', '--profile', profile, 'remove', 'dsh-claude-workspace'])
    const removed = await dsh(home, ['--profile', profile, '--dump-config'])
    assert.doesNotMatch(removed, /id: claude-workspace/)
    const after = await manifest(home)
    assert.equal(after.dependencies?.['dsh-claude-workspace'], undefined)
    assert.equal(after.dsh?.profile?.bundles?.includes('dsh-claude-workspace'), false)
    log('PASS')
  } finally {
    await removeTempDir(home)
  }
}

await main().catch((error) => {
  process.stderr.write(`[plugin-install] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
