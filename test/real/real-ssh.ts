#!/usr/bin/env node
// Real SSH E2E for dsh-claude-workspace. Run this from a machine that can
// already `ssh <alias>` without a password prompt. It drives Claude Code on the
// remote host through the same service the DSH plugin uses:
//
//   1. deep health check over ssh (executable, handshake, session/new)
//   2. adopt an existing remote directory as a workspace
//   3. Write allowed once  -> remote file exists with the expected content
//   4. Write rejected      -> remote file absent
//   5. widen to Edit(sub/**) -> rule written to the remote settings file,
//      then revoked; the original settings file is restored
//
// Required env:
//   CCW_SSH_ALIAS   ~/.ssh/config alias of the remote host
//   CCW_REMOTE_CWD  absolute existing directory on the remote host
// Optional env:
//   CCW_REMOTE_ACP      executable name or absolute path (default claude-agent-acp)
//   CCW_REMOTE_COMMAND  explicit remote command, e.g.
//                       "cd /path && exec ./node_modules/.bin/claude-agent-acp"
//
// It creates and removes only ccw-e2e-ssh-* files/directories in the remote
// directory and restores `.claude/settings.local.json` it touched.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createService, type CcwService } from '../../src/service.ts'
import type { CcwEvent } from '../../src/acp/mapping.ts'
import type { PendingPermission } from '../../src/gate/permission.ts'
import { findAllowOnce, findReject } from '../../src/gate/options.ts'
import { SshHost } from '../../src/host/ssh.ts'
import { makeTempDir, removeTempDir, waitFor } from '../helpers/temp.ts'

const alias = process.env.CCW_SSH_ALIAS ?? ''
const remoteCwd = process.env.CCW_REMOTE_CWD ?? ''
const remoteAcp = process.env.CCW_REMOTE_ACP ?? 'claude-agent-acp'
const remoteCommand = process.env.CCW_REMOTE_COMMAND

if (alias.length === 0 || remoteCwd.length === 0) {
  process.stderr.write(
    'usage: CCW_SSH_ALIAS=<host> CCW_REMOTE_CWD=<abs dir> [CCW_REMOTE_ACP=<exe>] [CCW_REMOTE_COMMAND=<cmd>] node test/real/real-ssh.ts\n',
  )
  process.exit(2)
}

const sshSettings = {
  connectTimeoutMs: 8000,
  serverAliveIntervalSec: 15,
  serverAliveCountMax: 3,
  strictHostKeyChecking: true,
}

const host = new SshHost({
  id: 'target',
  alias,
  executable: remoteAcp,
  args: [],
  ...(remoteCommand === undefined ? {} : { command: remoteCommand }),
  env: {},
  ssh: sshSettings,
  connectTimeoutMs: 8000,
})

function log(message: string): void {
  process.stdout.write(`[real-ssh] ${message}\n`)
}

async function main(): Promise<void> {
  const allowFile = join(remoteCwd, 'ccw-e2e-ssh-allow.txt')
  const rejectFile = join(remoteCwd, 'ccw-e2e-ssh-reject.txt')
  const widenDir = join(remoteCwd, 'ccw-e2e-ssh-sub')
  const widenFile = join(widenDir, 'widen.txt')
  const settingsFile = join(remoteCwd, '.claude', 'settings.local.json')
  const settingsBackupFile = `${settingsFile}.bak`
  const dataDir = await makeTempDir('ccw-real-ssh-')
  let service: CcwService | undefined
  let settingsBefore: string | undefined
  let backupBefore: string | undefined
  let widenDirExisted = false
  try {
    log(`alias=${alias} cwd=${remoteCwd} acp=${remoteAcp} command=${remoteCommand ?? '(default)'}`)
    const probe = await host.exec(['true'])
    assert.equal(probe.code, 0, `ssh ${alias} failed: ${probe.stderr.trim()}`)
    settingsBefore = await host.readText(settingsFile)
    backupBefore = await host.readText(settingsBackupFile)
    widenDirExisted = (await host.exec(['test', '-d', widenDir])).code === 0
    await host.mkdirp(widenDir)

    service = createService({
      config: {
        dataDir,
        hosts: {
          target: {
            kind: 'ssh',
            alias,
            executable: remoteAcp,
            ...(remoteCommand === undefined ? {} : { command: remoteCommand }),
            connectTimeoutMs: 8000,
          },
        },
        defaultHost: 'target',
        workspaces: { baseDir: join(dataDir, 'workspaces') },
        acp: {
          handshakeTimeoutMs: 20_000,
          requestTimeoutMs: 30_000,
          promptTimeoutMs: 0,
          idleRecycleMs: 0,
        },
        approvals: { timeoutMs: 0 },
        events: { bufferSize: 1000 },
        audit: { retainDays: 1 },
      },
    })
    const events: CcwEvent[] = []
    service.onEvent((event) => {
      if (event.type === 'session') events.push(event.event)
    })

    log('health check over ssh…')
    const health = await service.healthCheck('target', { cwd: remoteCwd })
    log(`health: ${JSON.stringify(health)}`)
    assert.equal(health.handshake, true, `handshake failed: ${health.error ?? ''}`)
    assert.equal(health.session, true, `session/new failed: ${health.error ?? ''}`)

    const workspace = await service.createWorkspace({ hostId: 'target', dir: remoteCwd, title: 'Remote E2E' })
    const opened = await service.openSession({ workspaceId: workspace.workspace.id, dshSessionId: 'remote-1' })
    log(`opened remote session ${opened.binding.acpSessionId} in ${opened.binding.cwd}`)

    const runPrompt = async (
      text: string,
      decide: (request: PendingPermission) => string | undefined,
    ) => {
      const outcome = service!.prompt({ dshSessionId: 'remote-1', text })
      const request = await waitFor(() => service!.pendingApprovals('remote-1')[0], 180_000)
      log(`permission ${request.toolCall.title ?? request.toolCall.toolCallId}: ${request.options.map((option) => `${option.kind}/${option.optionId}`).join(', ')}`)
      const optionId = decide(request)
      assert.ok(optionId, 'no matching permission option')
      await service!.answerPermission(request.requestId, optionId)
      return outcome
    }

    log('scenario: remote write allowed')
    const allowTurn = await runPrompt(
      'Use the Write tool to create a file named ccw-e2e-ssh-allow.txt in the current directory containing exactly: ssh-e2e. Do not use Bash.',
      (request) => findAllowOnce(request.options)?.optionId,
    )
    assert.equal(allowTurn.stopReason, 'end_turn')
    const written = await host.exec(['cat', '--', allowFile])
    assert.equal(written.code, 0, `could not read ${allowFile}: ${written.stderr.trim()}`)
    assert.equal(written.stdout.trim(), 'ssh-e2e')
    const listed = await service.listWorkspaceDirectory(workspace.workspace.id, { dshSessionId: 'remote-1' })
    assert.ok(listed.entries.some((entry) => entry.name === 'ccw-e2e-ssh-allow.txt'))

    log('scenario: remote write rejected')
    const rejectTurn = await runPrompt(
      'Use the Write tool to create a file named ccw-e2e-ssh-reject.txt in the current directory containing exactly: rejected. Do not use Bash.',
      (request) => findReject(request.options)?.optionId,
    )
    assert.equal(rejectTurn.stopReason, 'end_turn')
    const rejected = await host.exec(['test', '-e', rejectFile])
    assert.notEqual(rejected.code, 0, 'rejected write created the remote file')
    assert.ok(events.some((event) => event.type === 'tool-update' && event.card.status === 'failed'))

    log('scenario: remote widen writes and revokes a rule')
    const widenPrompt = service.prompt({
      dshSessionId: 'remote-1',
      text: 'Use the Write tool to create a file named ccw-e2e-ssh-sub/widen.txt in the current directory containing exactly: widened. Do not use Bash.',
    })
    const widenPending = await waitFor(() => service!.pendingApprovals('remote-1')[0], 180_000)
    const preview = await service.previewWiden(widenPending.requestId, 'prefix')
    log(`widen preview: ${JSON.stringify({ rules: preview.rules, file: preview.file })}`)
    assert.deepEqual(preview.rules, ['Edit(ccw-e2e-ssh-sub/**)'])
    assert.equal(preview.file, settingsFile)
    const applied = await service.widenPermission({ requestId: widenPending.requestId, scope: 'prefix' })
    assert.deepEqual(applied.rules, ['Edit(ccw-e2e-ssh-sub/**)'])
    assert.equal(applied.forwarded, false)
    const widenTurn = await widenPrompt
    assert.equal(widenTurn.stopReason, 'end_turn')
    assert.equal((await host.readText(widenFile))?.trim(), 'widened')
    const settingsText = await host.readText(settingsFile)
    assert.ok(
      settingsText !== undefined && settingsText.includes('Edit(ccw-e2e-ssh-sub/**)'),
      'rule was not written to the remote settings file',
    )
    const writtenRule = (await service.writtenRules()).find((rule) => rule.rule === 'Edit(ccw-e2e-ssh-sub/**)')
    assert.ok(writtenRule, 'written rule was not tracked')
    assert.equal(writtenRule.host, 'target')
    await service.revokeRule(writtenRule.id)
    const afterRevoke = await host.readText(settingsFile)
    assert.equal(afterRevoke?.includes('Edit(ccw-e2e-ssh-sub/**)'), false)

    log('PASS')
  } finally {
    await service?.close().catch(() => undefined)
    await host.exec(['rm', '-f', '--', allowFile, rejectFile, widenFile]).catch(() => undefined)
    if (!widenDirExisted) await host.exec(['rm', '-rf', '--', widenDir]).catch(() => undefined)
    if (settingsBefore === undefined) {
      await host.removeFile(settingsFile).catch(() => undefined)
      await host.removeFile(settingsBackupFile).catch(() => undefined)
    } else {
      await host.writeTextAtomic(settingsFile, settingsBefore, { mode: 0o600 }).catch(() => undefined)
      if (backupBefore === undefined) await host.removeFile(settingsBackupFile).catch(() => undefined)
      else await host.writeTextAtomic(settingsBackupFile, backupBefore, { mode: 0o600 }).catch(() => undefined)
    }
    await removeTempDir(dataDir)
  }
}

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[real-ssh] unhandled rejection: ${String(error)}\n`)
  process.exitCode = 1
})

await main().catch((error) => {
  process.stderr.write(`[real-ssh] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
