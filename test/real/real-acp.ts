#!/usr/bin/env node
// Real-environment E2E for dsh-claude-workspace on a machine where Claude Code
// is already logged in. It drives the real claude-agent-acp binary through the
// same service the DSH plugin uses:
//
//   1. deep health check (executable, handshake, session/new)
//   2. Write allowed once        -> file exists
//   3. Write rejected            -> file absent
//   4. Widen to Edit(sub/**)     -> rule written, file exists, rule revoked
//   5. Long Bash allowed then cancelled -> stopReason cancelled
//   6. Service restart + session/load -> replay events marked replay
//
// It never reads credentials. It restores/removes only the files it creates.
//
// Usage:
//   node test/real/real-acp.ts
//   CCW_REAL_CWD=/path/to/project CCW_ACP_BIN=/path/to/claude-agent-acp node test/real/real-acp.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createService, type CcwService } from '../../src/service.ts'
import type { CcwEvent } from '../../src/acp/mapping.ts'
import type { PendingPermission } from '../../src/gate/permission.ts'
import { findAllowOnce, findReject } from '../../src/gate/options.ts'
import { makeTempDir, removeTempDir, waitFor } from '../helpers/temp.ts'

const cwd = process.env.CCW_REAL_CWD ?? '/root/autodl-tmp/code/wangzhengzhuo512/claude-code-test'
const acpBin = process.env.CCW_ACP_BIN ?? join(cwd, 'node_modules', '.bin', 'claude-agent-acp')
const settingsFile = join(cwd, '.claude', 'settings.local.json')
const files = {
  allow: join(cwd, 'e2e-allow.txt'),
  reject: join(cwd, 'e2e-reject.txt'),
  widen: join(cwd, 'sub', 'e2e-widen.txt'),
}
const subDirectory = join(cwd, 'sub')

function log(message: string): void {
  process.stdout.write(`[real-e2e] ${message}\n`)
}

async function main(): Promise<void> {
  assert.ok(existsSync(acpBin), `claude-agent-acp not found at ${acpBin}`)
  assert.ok(existsSync(join(cwd, '.claude', 'settings.json')), `project settings missing under ${cwd}`)
  log(`cwd: ${cwd}`)
  log(`acp: ${acpBin}`)

  const settingsExisted = existsSync(settingsFile)
  const settingsBackup = settingsExisted ? await readFile(settingsFile, 'utf8') : undefined
  const subExisted = existsSync(subDirectory)
  const dataDir = await makeTempDir('ccw-real-')

  const config = {
    dataDir,
    hosts: { local: { kind: 'local' as const, executable: acpBin } },
    workspaces: { baseDir: join(dataDir, 'workspaces') },
    acp: {
      handshakeTimeoutMs: 20_000,
      requestTimeoutMs: 30_000,
      promptTimeoutMs: 0,
      idleRecycleMs: 0,
    },
    approvals: { timeoutMs: 0 },
    events: { bufferSize: 2000 },
    audit: { retainDays: 1 },
  }

  let service: CcwService | undefined
  try {
    await cleanup()
    await mkdir(subDirectory, { recursive: true })

    service = createService({ config })
    const events: CcwEvent[] = []
    service.onEvent((event) => {
      if (event.type !== 'session') return
      events.push(event.event)
      if (event.event.type === 'tool-call') {
        log(`tool-call ${event.event.card.toolCallId} ${event.event.card.kind} ${event.event.card.title}`)
      }
      if (event.event.type === 'tool-update') {
        log(`tool-update ${event.event.card.toolCallId} -> ${event.event.card.status}`)
      }
    })

    log('health check…')
    const health = await service.healthCheck('local', { cwd })
    log(`health: ${JSON.stringify(health)}`)
    assert.equal(health.handshake, true, `handshake failed: ${health.error ?? ''}`)
    assert.equal(health.session, true, `session/new failed: ${health.error ?? ''}`)

    const workspace = await service.createWorkspace({ hostId: 'local', dir: cwd, title: 'Real E2E' })
    const opened = await service.openSession({ workspaceId: workspace.workspace.id, dshSessionId: 'real-1' })
    log(`opened session ${opened.binding.acpSessionId}`)
    log(`config options: ${opened.configOptions.map((option) => option.id).join(', ')}`)
    assert.ok(opened.configOptions.length > 0, 'the agent reported no config options')

    const runPermissionPrompt = async (
      text: string,
      decide: (request: PendingPermission) => string | undefined,
      timeoutMs = 180_000,
    ) => {
      const outcome = service!.prompt({ dshSessionId: 'real-1', text })
      const request = await waitFor(() => service!.pendingApprovals('real-1')[0], timeoutMs)
      log(`permission ${request.toolCall.title ?? request.toolCall.toolCallId}: ${request.options.map((option) => `${option.kind}/${option.optionId}`).join(', ')}`)
      const optionId = decide(request)
      assert.ok(optionId, 'no matching option for the decision')
      await service!.answerPermission(request.requestId, optionId)
      return outcome
    }

    log('scenario: allow once')
    const allowOutcome = await runPermissionPrompt(
      'Use the Write tool to create a file named e2e-allow.txt in the current directory containing exactly: hello-e2e. Do not use Bash.',
      (request) => findAllowOnce(request.options)?.optionId,
    )
    log(`allow turn: ${allowOutcome.stopReason}`)
    assert.equal(allowOutcome.stopReason, 'end_turn')
    assert.equal((await readFile(files.allow, 'utf8')).trim(), 'hello-e2e')

    log('scenario: reject')
    const rejectOutcome = await runPermissionPrompt(
      'Use the Write tool to create a file named e2e-reject.txt in the current directory containing exactly: rejected. Do not use Bash.',
      (request) => findReject(request.options)?.optionId,
    )
    log(`reject turn: ${rejectOutcome.stopReason}`)
    assert.equal(existsSync(files.reject), false, 'rejected write must not create the file')

    log('scenario: widen to Edit(sub/**)')
    const widenOutcome = await runPermissionPrompt(
      'Use the Write tool to create a file named sub/e2e-widen.txt in the current directory containing exactly: widened. Do not use Bash.',
      (request) => findAllowOnce(request.options)?.optionId,
    )
    assert.equal(widenOutcome.stopReason, 'end_turn')
    assert.equal((await readFile(files.widen, 'utf8')).trim(), 'widened')

    log('scenario: widen writes and revokes a rule')
    const widenPrompt = service.prompt({
      dshSessionId: 'real-1',
      text: 'Use the Write tool to create a file named sub/e2e-widen-2.txt in the current directory containing exactly: widened-2. Do not use Bash.',
    })
    const widenPending = await waitFor(() => service!.pendingApprovals('real-1')[0], 180_000)
    const preview = await service.previewWiden(widenPending.requestId, 'prefix')
    log(`widen preview: ${JSON.stringify({ rules: preview.rules, file: preview.file, requiresConfirmation: preview.requiresConfirmation })}`)
    assert.deepEqual(preview.rules, ['Edit(sub/**)'])
    const applied = await service.widenPermission({ requestId: widenPending.requestId, scope: 'prefix' })
    assert.deepEqual(applied.rules, ['Edit(sub/**)'])
    const widenTurn = await widenPrompt
    assert.equal(widenTurn.stopReason, 'end_turn')
    assert.equal((await readFile(join(cwd, 'sub', 'e2e-widen-2.txt'), 'utf8')).trim(), 'widened-2')
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.ok(settings.permissions.allow.includes('Edit(sub/**)'), 'rule was not written to settings.local.json')
    const written = await service.writtenRules()
    const entry = written.find((rule) => rule.rule === 'Edit(sub/**)')
    assert.ok(entry, 'written rule was not tracked')
    await service.revokeRule(entry.id)
    const after = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.equal(after.permissions.allow.includes('Edit(sub/**)'), false)

    log('scenario: allowed Bash then cancel')
    const bashToolIds = new Set<string>()
    const cancelPrompt = service.prompt({
      dshSessionId: 'real-1',
      text: "Run this exact Bash command and wait for it: python3 -c 'import time; time.sleep(60)'. Do not use any other tool.",
    })
    const bashRequest = await waitFor(() => service!.pendingApprovals('real-1')[0], 180_000)
    bashToolIds.add(bashRequest.toolCall.toolCallId)
    log(`bash permission: ${bashRequest.toolCall.title ?? 'unknown'}`)
    const bashAllow = findAllowOnce(bashRequest.options)?.optionId
    assert.ok(bashAllow)
    await service.answerPermission(bashRequest.requestId, bashAllow!)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await service.cancelSession('real-1')
    const cancelOutcome = await cancelPrompt
    log(`cancel turn: ${cancelOutcome.stopReason}`)
    assert.equal(cancelOutcome.cancelled, true)
    const finalStatuses = new Map<string, string>()
    for (const event of events) {
      if (event.type === 'tool-call' || event.type === 'tool-update') finalStatuses.set(event.card.toolCallId, event.card.status)
    }
    for (const toolCallId of bashToolIds) {
      assert.equal(finalStatuses.get(toolCallId), 'cancelled', 'cancelled tool card was overwritten by a later status')
    }

    log('scenario: forward Claude\'s allow-with-updates (scope command)')
    const forwardPrompt = service.prompt({
      dshSessionId: 'real-1',
      text: 'Use the Write tool to create a file named e2e-forward.txt in the current directory containing exactly: forwarded. Do not use Bash.',
    })
    const forwardPending = await waitFor(() => service!.pendingApprovals('real-1')[0], 180_000)
    const forwarded = await service.widenPermission({ requestId: forwardPending.requestId, scope: 'command' })
    log(`forwarded=${forwarded.forwarded} rules=${JSON.stringify(forwarded.rules)}`)
    assert.equal(forwarded.forwarded, true)
    assert.deepEqual(forwarded.rules, [])
    const forwardTurn = await forwardPrompt
    assert.equal(forwardTurn.stopReason, 'end_turn')
    assert.equal((await readFile(join(cwd, 'e2e-forward.txt'), 'utf8')).trim(), 'forwarded')
    log(`Write forward settings present: ${existsSync(settingsFile)} (Claude decides Edit persistence)`)

    log('scenario: forward allow-with-updates for Bash and observe Claude\'s persistence')
    const bashForwardPrompt = service.prompt({
      dshSessionId: 'real-1',
      text: "Run this exact Bash command and wait for it: python3 -c 'import time; time.sleep(2)'. Do not use any other tool.",
    })
    const bashForwardPending = await waitFor(() => service!.pendingApprovals('real-1')[0], 180_000)
    const bashForwarded = await service.widenPermission({ requestId: bashForwardPending.requestId, scope: 'command' })
    log(`bash forwarded=${bashForwarded.forwarded}`)
    assert.equal(bashForwarded.forwarded, true)
    await bashForwardPrompt
    assert.equal(existsSync(settingsFile), true, 'forwarded Bash option did not persist a settings rule')
    const bashForwardedSettings = JSON.parse(await readFile(settingsFile, 'utf8'))
    const forwardedRules: string[] = bashForwardedSettings.permissions?.allow ?? []
    log(`Claude-written rules: ${JSON.stringify(forwardedRules)}`)
    assert.ok(forwardedRules.some((rule) => rule.startsWith('Bash(')), 'no Bash rule was persisted')
    assert.ok(forwardedRules.some((rule) => rule.includes('\\(')), 'Claude did not escape parentheses in the stored rule')

    log('scenario: model selection survives session/load')
    const modelOption = opened.configOptions.find((option) => option.id === 'model')
    const modelValues = collectSelectValues(modelOption?.options)
    const chosenModel = modelValues.find((value) => value !== modelOption?.currentValue)
    if (chosenModel === undefined) {
      log(`model option has no alternative value (current=${String(modelOption?.currentValue)}); skipping`)
    } else {
      const updated = await service.setOption('real-1', 'model', chosenModel)
      log(`set model to ${chosenModel} (was ${String(modelOption?.currentValue)})`)
      assert.equal(updated.model, chosenModel)
    }

    const auditFiles = await stat(join(dataDir, 'audit')).then(
      () => true,
      () => false,
    )
    assert.equal(auditFiles, true, 'audit directory was not created')

    log('scenario: restart and session/load')
    const replayEvents: CcwEvent[] = []
    const workspaceId = workspace.workspace.id
    await service.close()
    service = createService({ config })
    service.onEvent((event) => {
      if (event.type === 'session') replayEvents.push(event.event)
    })
    const reopened = await service.openSession({ workspaceId, dshSessionId: 'real-1' })
    log(`reopened: resumed=${reopened.resumed}, replayed=${replayEvents.length}`)
    assert.equal(reopened.resumed, true)
    assert.ok(replayEvents.length > 0, 'session/load replayed no events')
    assert.ok(replayEvents.every((event) => event.replay), 'replayed events were not marked')
    assert.ok(replayEvents.some((event) => event.type === 'tool-call'), 'replay contained no tool cards')

    log('PASS')
  } finally {
    await service?.close().catch(() => undefined)
    await cleanup()
    await removeTempDir(dataDir)
    await restoreSettings(settingsBackup, settingsExisted)
    if (!subExisted) await rm(subDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function cleanup(): Promise<void> {
  await rm(join(cwd, 'e2e-forward.txt'), { force: true }).catch(() => undefined)
  for (const file of Object.values(files)) await rm(file, { force: true }).catch(() => undefined)
  await rm(join(cwd, 'sub', 'e2e-widen-2.txt'), { force: true }).catch(() => undefined)
}

/** Flattens a config option's flat or grouped select values. */
function collectSelectValues(options: readonly unknown[] | undefined): string[] {
  if (options === undefined) return []
  const values: string[] = []
  for (const entry of options) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { value?: unknown; options?: unknown }
    if (typeof record.value === 'string') values.push(record.value)
    if (Array.isArray(record.options)) values.push(...collectSelectValues(record.options))
  }
  return values
}

async function restoreSettings(backup: string | undefined, existed: boolean): Promise<void> {
  if (existed && backup !== undefined) await writeFile(settingsFile, backup, { mode: 0o600 })
  else await rm(settingsFile, { force: true })
}

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[real-e2e] unhandled rejection: ${String(error)}\n`)
  process.exitCode = 1
})

await main().catch((error) => {
  process.stderr.write(`[real-e2e] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
