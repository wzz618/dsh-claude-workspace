import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionTranslator, extractDiffs, normalizeStatus } from '../../src/acp/mapping.ts'

test('one tool call produces one card and later updates mutate it', () => {
  const translator = new SessionTranslator('acp-1', () => 100)
  const first = translator.translate({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Preparing file…',
    kind: 'edit',
    status: 'in_progress',
    content: [{ type: 'diff', path: '/w/a.txt', oldText: 'old', newText: 'new' }],
  })
  assert.equal(first.length, 1)
  assert.equal(first[0]!.type, 'tool-call')
  const later = translator.translate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    title: 'Write a.txt',
    status: 'completed',
    content: [{ type: 'diff', path: '/w/a.txt', oldText: '', newText: 'new' }],
  })
  assert.equal(later[0]!.type, 'tool-update')
  assert.equal(translator.cards().length, 1)
  const card = translator.cards()[0]!
  assert.equal(card.title, 'Write a.txt')
  assert.equal(card.status, 'ok')
  assert.equal(card.diffs[0]!.path, '/w/a.txt')
  assert.equal(card.createdAt, 100)
})

test('status mapping keeps pending, running, ok, and failed distinct', () => {
  assert.equal(normalizeStatus('pending'), 'pending')
  assert.equal(normalizeStatus('in_progress'), 'running')
  assert.equal(normalizeStatus('completed'), 'ok')
  assert.equal(normalizeStatus('failed'), 'failed')
  assert.equal(normalizeStatus('unknown'), 'pending')
})

test('text, thinking, plan, commands, and mode become typed events', () => {
  const translator = new SessionTranslator('acp-1')
  assert.equal(translator.translate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' },
  })[0]!.type, 'assistant-text')
  assert.equal(translator.translate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  })[0]!.type, 'thinking')
  assert.equal(translator.translate({
    sessionUpdate: 'plan',
    entries: [{ content: 'step', priority: 'medium', status: 'pending' }],
  })[0]!.type, 'plan')
  assert.equal(translator.translate({
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'compact', description: 'Compact' }],
  })[0]!.type, 'commands')
  assert.equal(translator.translate({
    sessionUpdate: 'current_mode_update',
    currentModeId: 'plan',
  })[0]!.type, 'mode')
})

test('unknown updates are preserved instead of dropped', () => {
  const translator = new SessionTranslator('acp-1')
  const event = translator.translate({ sessionUpdate: 'future_update', payload: 1 } as never)
  assert.equal(event[0]!.type, 'unknown')
})

test('cancelling marks only running and pending cards', () => {
  const translator = new SessionTranslator('acp-1')
  translator.translate({ sessionUpdate: 'tool_call', toolCallId: 'done', title: 'Read', status: 'completed' })
  translator.translate({ sessionUpdate: 'tool_call', toolCallId: 'running', title: 'Bash', status: 'in_progress' })
  const cancelled = translator.markCancelled()
  assert.equal(cancelled.length, 1)
  const states = Object.fromEntries(translator.cards().map((card) => [card.toolCallId, card.status]))
  assert.deepEqual(states, { done: 'ok', running: 'cancelled' })
})

test('a cancelled card stays cancelled when the agent later reports failed', () => {
  const translator = new SessionTranslator('acp-1')
  translator.translate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' })
  translator.markCancelled()
  translator.translate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' })
  assert.equal(translator.cards()[0]!.status, 'cancelled')
})

test('replay events carry the replay marker', () => {
  const translator = new SessionTranslator('acp-1')
  const events = translator.translate(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } },
    { replay: true },
  )
  assert.equal(events[0]!.replay, true)
})

test('extractDiffs ignores non-diff content', () => {
  assert.deepEqual(extractDiffs([{ type: 'content', content: { type: 'text', text: 'x' } }]), [])
  const diffs = extractDiffs([{ type: 'diff', path: '/a', oldText: 'x\n', newText: 'y\n' }])
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0]!.added, 1)
  assert.equal(diffs[0]!.removed, 1)
})

test('subagent tool calls keep their launching call id from _meta', () => {
  const translator = new SessionTranslator('acp-1', () => 100)
  translator.translate({
    sessionUpdate: 'tool_call',
    toolCallId: 'agent-1',
    title: 'Task',
    name: 'Agent',
    kind: 'think',
    status: 'pending',
  })
  translator.translate({
    sessionUpdate: 'tool_call',
    toolCallId: 'child-1',
    title: 'ls',
    kind: 'execute',
    status: 'pending',
    _meta: { claudeCode: { parentToolUseId: 'agent-1' } },
  })
  translator.translate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'child-1',
    status: 'completed',
  })
  const cards = translator.cards()
  assert.equal(cards.length, 2)
  assert.equal(cards[0]!.parentToolCallId, undefined)
  assert.equal(cards[1]!.parentToolCallId, 'agent-1')
})

test('malformed _meta does not invent a parent', () => {
  const translator = new SessionTranslator('acp-1', () => 100)
  translator.translate({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Read',
    _meta: { claudeCode: { parentToolUseId: 42 } },
  })
  translator.translate({
    sessionUpdate: 'tool_call',
    toolCallId: 't2',
    title: 'Read',
    _meta: { claudeCode: 'nope' },
  })
  assert.deepEqual(translator.cards().map((card) => card.parentToolCallId), [undefined, undefined])
})
