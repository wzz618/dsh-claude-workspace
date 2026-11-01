import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CcwConfigInput } from '../../src/config.ts'
import { createService, type CcwService } from '../../src/service.ts'
import type { CcwEvent } from '../../src/acp/mapping.ts'
import { makeTempDir, removeTempDir, waitFor, waitForAsync } from '../helpers/temp.ts'

const fakeServer = fileURLToPath(new URL('../fake-acp/server.mjs', import.meta.url))

interface Context {
  service: CcwService
  workspaceId: string
  workspaceDir: string
  dataDir: string
  events: CcwEvent[]
  cleanup: () => Promise<void>
}

async function setup(scenario: string): Promise<Context> {
  const dataDir = await makeTempDir()
  const config: CcwConfigInput = {
    dataDir,
    hosts: {
      local: {
        kind: 'local',
        executable: process.execPath,
        args: [fakeServer, scenario],
      },
    },
    workspaces: { baseDir: join(dataDir, 'workspaces') },
    acp: { handshakeTimeoutMs: 5000, requestTimeoutMs: 5000, idleRecycleMs: 0 },
    events: { bufferSize: 200 },
  }
  const service = createService({ config })
  const created = await service.createWorkspace({ hostId: 'local', title: 'Test' })
  const events: CcwEvent[] = []
  service.onEvent((event) => {
    if (event.type === 'session') events.push(event.event)
  })
  return {
    service,
    workspaceId: created.workspace.id,
    workspaceDir: created.workspace.dir,
    dataDir,
    events,
    cleanup: async () => {
      await service.close()
      await removeTempDir(dataDir)
    },
  }
}

test('opens a session, streams a tool card, allows it, and writes the file', async () => {
  const context = await setup('perm')
  try {
    const opened = await context.service.openSession({
      workspaceId: context.workspaceId,
      dshSessionId: 'dsh-1',
    })
    assert.equal(opened.resumed, false)
    assert.ok(opened.configOptions.some((option) => option.id === 'model'))
    assert.equal(opened.modes?.availableModes.length, 3)

    const prompt = context.service.prompt({ dshSessionId: 'dsh-1', text: 'create a.txt' })
    const pending = await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    assert.equal(pending.sessionId, 'acp-session-1')
    assert.deepEqual(
      pending.options.map((option) => option.optionId),
      ['allow-once', 'allow-updates', 'reject-once'],
    )
    await context.service.answerPermission(pending.requestId, 'allow-once')
    const outcome = await prompt
    assert.equal(outcome.stopReason, 'end_turn')
    assert.equal(await readFile(join(context.workspaceDir, 'a.txt'), 'utf8'), 'hello\n')

    const toolCards = context.events.filter((event) => event.type === 'tool-call')
    assert.equal(toolCards.length, 1)
    const updates = context.events.filter((event) => event.type === 'tool-update')
    assert.ok(updates.some((event) => event.type === 'tool-update' && event.card.status === 'ok'))
    assert.ok(context.events.some((event) => event.type === 'assistant-text' && event.text.includes('hello')))
    assert.equal(context.service.pendingApprovals().length, 0)
  } finally {
    await context.cleanup()
  }
})

test('rejecting a permission leaves the file unmodified and reports failure', async () => {
  const context = await setup('perm')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'dsh-1' })
    const prompt = context.service.prompt({ dshSessionId: 'dsh-1', text: 'create a.txt' })
    const pending = await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    await context.service.answerPermission(pending.requestId, 'reject-once')
    const outcome = await prompt
    assert.equal(outcome.stopReason, 'end_turn')
    assert.equal(existsSync(join(context.workspaceDir, 'a.txt')), false)
    assert.ok(
      context.events.some((event) => event.type === 'tool-update' && event.card.status === 'failed'),
    )
  } finally {
    await context.cleanup()
  }
})

test('widening to a command prefix writes the rule and answers allow-once', async () => {
  const context = await setup('bash')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'dsh-1' })
    const prompt = context.service.prompt({ dshSessionId: 'dsh-1', text: 'run tests' })
    const pending = await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    const preview = await context.service.previewWiden(pending.requestId, 'prefix')
    assert.deepEqual(preview.rules, ['Bash(npm test:*)'])
    assert.equal(preview.highRisk, false)
    assert.equal(preview.requiresConfirmation, false)
    assert.equal(preview.file, join(context.workspaceDir, '.claude', 'settings.local.json'))
    const applied = await context.service.widenPermission({ requestId: pending.requestId, scope: 'prefix' })
    assert.deepEqual(applied.rules, ['Bash(npm test:*)'])
    assert.equal(applied.forwarded, false)
    await prompt
    const settings = JSON.parse(await readFile(preview.file, 'utf8'))
    assert.deepEqual(settings.permissions.allow, ['Bash(npm test:*)'])
    const written = await context.service.writtenRules()
    assert.equal(written.length, 1)
    assert.equal(written[0]!.rule, 'Bash(npm test:*)')
    await context.service.revokeRule(written[0]!.id)
    const after = JSON.parse(await readFile(preview.file, 'utf8'))
    assert.deepEqual(after.permissions.allow, [])
  } finally {
    await context.cleanup()
  }
})

test('a widened session rule auto-approves the next matching call', async () => {
  const context = await setup('bash')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'dsh-1' })
    const first = context.service.prompt({ dshSessionId: 'dsh-1', text: 'run tests' })
    const pending = await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    await context.service.widenPermission({ requestId: pending.requestId, scope: 'prefix' })
    await first

    const second = context.service.prompt({ dshSessionId: 'dsh-1', text: 'run tests again' })
    const outcome = await second
    assert.equal(outcome.stopReason, 'end_turn')
    assert.ok(context.events.some(
      (event) => event.type === 'auto-approved' && event.rule === 'Bash(npm test:*)',
    ))
    assert.equal(context.service.pendingApprovals('dsh-1').length, 0)
  } finally {
    await context.cleanup()
  }
})

test('cancelling a running turn resolves as cancelled', async () => {  const context = await setup('slow')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'dsh-1' })
    const prompt = context.service.prompt({ dshSessionId: 'dsh-1', text: 'wait forever' })
    await waitFor(() => context.events.some((event) => event.type === 'assistant-text' && event.text === 'working'))
    await assert.rejects(
      context.service.prompt({ dshSessionId: 'dsh-1', text: 'second turn' }),
      /already running in this session/,
    )
    await context.service.cancelSession('dsh-1')
    const outcome = await prompt
    assert.equal(outcome.cancelled, true)
    assert.equal(outcome.stopReason, 'cancelled')
    const reattach = await context.service.reattach('dsh-1')
    assert.equal(reattach.running, false)
  } finally {
    await context.cleanup()
  }
})

test('a restarted service reloads the binding and marks replay events', async () => {
  const dataDir = await makeTempDir()
  const config: CcwConfigInput = {
    dataDir,
    hosts: { local: { kind: 'local', executable: process.execPath, args: [fakeServer, 'load'] } },
    workspaces: { baseDir: join(dataDir, 'workspaces') },
    acp: { handshakeTimeoutMs: 5000, requestTimeoutMs: 5000, idleRecycleMs: 0 },
    events: { bufferSize: 200 },
  }
  const first = createService({ config })
  try {
    const created = await first.createWorkspace({ hostId: 'local' })
    await first.openSession({ workspaceId: created.workspace.id, dshSessionId: 'dsh-1' })
    await first.close()

    const second = createService({ config })
    try {
      const events: CcwEvent[] = []
      second.onEvent((event) => {
        if (event.type === 'session') events.push(event.event)
      })
      const opened = await second.openSession({
        workspaceId: created.workspace.id,
        dshSessionId: 'dsh-1',
        model: 'opus',
      })
      assert.equal(opened.resumed, true)
      assert.ok(opened.configOptions.some((option) => option.id === 'model'))
      assert.equal(opened.modes?.availableModes.length, 3)
      assert.ok(events.length >= 2)
      assert.ok(events.every((event) => event.replay))
      assert.ok(events.some((event) => event.type === 'assistant-text'))
      assert.ok(events.some((event) => event.type === 'tool-call' && event.card.toolCallId === 't-old'))
      const binding = await second.listSessions()
      assert.equal(binding[0]!.acpSessionId, 'acp-session-1')
      assert.equal(binding[0]!.model, 'opus')
    } finally {
      await second.close()
    }
  } finally {
    await removeTempDir(dataDir)
  }
})

test('health check performs a real handshake and session creation', async () => {
  const context = await setup('perm')
  try {
    const report = await context.service.healthCheck('local', { cwd: context.workspaceDir })
    assert.equal(report.ok, true)
    assert.equal(report.handshake, true)
    assert.equal(report.session, true)
    assert.equal(report.executable !== undefined, true)
  } finally {
    await context.cleanup()
  }
})

test('two sessions in one workspace route permission requests independently', async () => {
  const context = await setup('perm')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'a' })
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'b' })
    const promptA = context.service.prompt({ dshSessionId: 'a', text: 'one' })
    const promptB = context.service.prompt({ dshSessionId: 'b', text: 'two' })
    const a = await waitFor(() => context.service.pendingApprovals('a')[0])
    const b = await waitFor(() => context.service.pendingApprovals('b')[0])
    assert.notEqual(a.requestId, b.requestId)
    await context.service.answerPermission(a.requestId, 'reject-once')
    await context.service.answerPermission(b.requestId, 'allow-once')
    await Promise.all([promptA, promptB])
    assert.equal(context.service.pendingApprovals().length, 0)
  } finally {
    await context.cleanup()
  }
})

test('a crashed process marks the session disconnected and reconnect recovers', async () => {
  const context = await setup('die')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'dsh-1' })
    const prompt = context.service.prompt({ dshSessionId: 'dsh-1', text: 'crash after approval' })
    const pending = await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    await context.service.answerPermission(pending.requestId, 'allow-once')
    await assert.rejects(prompt, /connection closed|disconnected/)

    const disconnected = await waitForAsync(async () => {
      const result = await context.service.reattach('dsh-1')
      return result.state === 'disconnected' ? result : undefined
    })
    assert.equal(disconnected.running, false)

    const reopened = await context.service.reconnectSession('dsh-1')
    assert.equal(reopened.resumed, true)
    const prompt2 = context.service.prompt({ dshSessionId: 'dsh-1', text: 'create a.txt after reconnect' })
    const pending2 = await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    await context.service.answerPermission(pending2.requestId, 'allow-once')
    const outcome = await prompt2
    assert.equal(outcome.stopReason, 'end_turn')
    assert.equal(await readFile(join(context.workspaceDir, 'a.txt'), 'utf8'), 'hello\n')
  } finally {
    await context.cleanup()
  }
})

test('a crash with a pending approval expires it and is audited', async () => {
  const context = await setup('die-pending')
  try {
    await context.service.openSession({ workspaceId: context.workspaceId, dshSessionId: 'dsh-1' })
    const prompt = context.service.prompt({ dshSessionId: 'dsh-1', text: 'crash while waiting' })
    await waitFor(() => context.service.pendingApprovals('dsh-1')[0])
    await assert.rejects(prompt, /connection closed|disconnected/)
    await waitForAsync(async () => context.service.pendingApprovals('dsh-1').length === 0 ? true : undefined)

    const day = new Date().toISOString().slice(0, 10)
    const expired = await waitForAsync(async () => {
      const entries = await context.service.auditEntries(day)
      return entries.find((entry) => entry.kind === 'permission' && entry.decision.startsWith('expired:'))
    })
    assert.match(expired.decision, /connection closed/)

    const reopened = await context.service.reconnectSession('dsh-1')
    assert.equal(reopened.resumed, true)
  } finally {
    await context.cleanup()
  }
})
