import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanGate } from '../../src/gate/plan.ts'

const entries = [
  { content: 'inspect the repo', priority: 'high', status: 'completed' },
  { content: 'write the patch', priority: 'medium', status: 'pending' },
]

test('records the latest plan and exposes it as pending', () => {
  const gate = new PlanGate({ now: () => 42 })
  const snapshot = gate.record('s1', entries)
  assert.equal(snapshot.receivedAt, 42)
  assert.deepEqual(gate.get('s1')!.entries, entries)
  assert.equal(gate.pending().length, 1)
})

test('records approve, revise, and cancel decisions', () => {
  const gate = new PlanGate()
  gate.record('s1', entries)
  assert.equal(gate.decide('s1', { kind: 'approve', feedback: 'go' }).decision!.kind, 'approve')
  assert.equal(gate.pending().length, 0)

  gate.record('s2', entries, true)
  assert.equal(gate.get('s2')!.replay, true)
  assert.equal(gate.decide('s2', { kind: 'revise', feedback: 'change step 2' }).decision!.kind, 'revise')

  gate.record('s3', entries)
  assert.equal(gate.decide('s3', { kind: 'cancel' }).decision!.kind, 'cancel')
})

test('deciding without a recorded plan is an error; forget clears state', () => {
  const gate = new PlanGate()
  assert.throws(() => gate.decide('missing', { kind: 'cancel' }), /no plan is recorded/)
  gate.record('s1', entries)
  gate.forget('s1')
  assert.equal(gate.get('s1'), undefined)
  assert.equal(gate.pending().length, 0)
})
