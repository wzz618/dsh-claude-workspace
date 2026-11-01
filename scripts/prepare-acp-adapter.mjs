#!/usr/bin/env node
// Rebuilds the migrated ACP adapter used by the P2b integration from the
// published package plus vendor/acp-adapter/migration.patch.
//
// Usage: node scripts/prepare-acp-adapter.mjs [target-dir]
//   default target: /tmp/dsh-acp-adapter
//   env CCW_ACP_ADAPTER_VERSION: upstream version (default 0.1.0-rc.10)
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = process.env.CCW_ACP_ADAPTER_VERSION ?? '0.1.0-rc.10'
const target = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-acp-adapter'))
const patch = join(root, 'vendor', 'acp-adapter', 'migration.patch')

if (!existsSync(patch)) throw new Error(`migration patch not found: ${patch}`)

function run(command, args, cwd) {
  process.stdout.write(`[prepare-acp-adapter] ${command} ${args.join(' ')}\n`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

const work = await mkdtemp(join(tmpdir(), 'ccw-acp-adapter-'))
try {
  run('npm', ['pack', `@zaimokuza/dsh-acp-adapter@${version}`, '--pack-destination', work], work)
  const tarball = execFileSync('sh', ['-c', `ls "${work}"/*.tgz`], { encoding: 'utf8' }).trim()
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], work)
  run('patch', ['-p1', '-d', target, '-i', patch], work)
  run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], target)
  process.stdout.write(
    `[prepare-acp-adapter] ready: ${target}\n`
    + `[prepare-acp-adapter] next: seed $DSH_HOME/dsh-acp/agents.json, then `
    + `dsh plugin --profile <name> add ${target}\n`,
  )
} finally {
  await rm(work, { recursive: true, force: true })
}
