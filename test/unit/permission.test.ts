import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../../src/gate/permission.ts'
import type { PermissionOption } from '../../src/acp/types.ts'

const options: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-updates', name: "Don't ask again", kind: 'allow_with_updates' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

function request(gate: PermissionGate, toolCallId = 't1') {
  return gate.request({
    sessionId: 'acp-1',
    dshSessionId: 'sess-1',
    workspaceId: 'ws-1',
    toolCall: { toolCallId, title: 'Write a.txt', rawInput: { file_path: '/w/a.txt' } },
    options,
  })
}

test('a request stays pending until answered and then resolves with that option', async () => {
  const gate = new PermissionGate({ timeoutMs: 0 })
  const decision = request(gate)
  const pending = gate.pending()
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.status, 'pending')
  gate.answer(pending[0]!.requestId, 'allow-once')
  assert.deepEqual(await decision, { kind: 'option', optionId: 'allow-once' })
  assert.equal(gate.pending().length, 0)
  assert.equal(gate.get(pending[0]!.requestId)!.status, 'answered')
})

test('an option that is not part of the request is rejected', () => {
  const gate = new PermissionGate({ timeoutMs: 0 })
  void request(gate)
  const id = gate.pending()[0]!.requestId
  assert.throws(() => gate.answer(id, 'made-up'), /does not belong/)
  gate.expireAll('done')
})

test('duplicate requests for one tool call share a decision', () => {
  const gate = new PermissionGate({ timeoutMs: 0 })
  const first = request(gate, 'same')
  const second = request(gate, 'same')
  assert.equal(first, second)
  assert.equal(gate.pending().length, 1)
  gate.answer(gate.pending()[0]!.requestId, 'allow-once')
  void first
  void second
})

test('expiring resolves with a reason and keeps history', async () => {
  const gate = new PermissionGate({ timeoutMs: 0 })
  const decision = request(gate)
  const id = gate.pending()[0]!.requestId
  gate.expire(id, 'connection closed')
  assert.deepEqual(await decision, { kind: 'expired', reason: 'connection closed' })
  assert.equal(gate.get(id)!.status, 'expired')
  assert.equal(gate.get(id)!.expiredReason, 'connection closed')
})

test('configured timeouts expire the request', async () => {
  const gate = new PermissionGate({ timeoutMs: 10 })
  const decision = request(gate)
  const result = await decision
  assert.equal(result.kind, 'expired')
  assert.match(result.kind === 'expired' ? result.reason : '', /timed out/)
  assert.equal(gate.pending().length, 0)
})

test('expireAll can be limited to one ACP session', async () => {
  const gate = new PermissionGate({ timeoutMs: 0 })
  const one = gate.request({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1', title: 'one' },
    options,
  })
  const two = gate.request({
    sessionId: 'acp-2',
    toolCall: { toolCallId: 't2', title: 'two' },
    options,
  })
  gate.expireAll('closed', { sessionId: 'acp-1' })
  assert.equal((await one).kind, 'expired')
  assert.equal(gate.pending('acp-2').length, 1)
  gate.expireAll('closed')
  assert.equal((await two).kind, 'expired')
})

test('pending records carry the DSH session and replay marker', () => {
  const gate = new PermissionGate({ timeoutMs: 0 })
  void gate.request({
    sessionId: 'acp-1',
    dshSessionId: 'sess-1',
    toolCall: { toolCallId: 't1', title: 'x' },
    options,
    replay: true,
  })
  const record = gate.pending()[0]!
  assert.equal(record.dshSessionId, 'sess-1')
  assert.equal(record.replay, true)
  gate.expireAll('done')
})
