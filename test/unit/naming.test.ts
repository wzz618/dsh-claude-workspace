import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveDirectory, MAX_DIRECTORY_NAME_LENGTH } from '../../src/workspace/naming.ts'

const base = {
  workspaceId: 'ws_abc',
  strategy: 'per-workspace' as const,
  createdAt: 1_700_000_000_000,
  hostIdentity: 'local',
  baseDir: '/data/workspaces',
  prefix: 'cc-',
}

test('derived names are deterministic and keep the readable identifier', () => {
  const first = deriveDirectory(base)
  const second = deriveDirectory(base)
  assert.equal(first, second)
  assert.match(first, /^\/data\/workspaces\/cc-ws_abc-[0-9a-f]{16}$/)
})

test('lossy replacement never makes a:b collide with a-b', () => {
  const colon = deriveDirectory({ ...base, workspaceId: 'conv:a' })
  const dash = deriveDirectory({ ...base, workspaceId: 'conv-a' })
  assert.notEqual(colon, dash)
  assert.match(colon, /conv-a-[0-9a-f]{16}$/)
  assert.match(dash, /conv-a-[0-9a-f]{16}$/)
})

test('the total name stays within the 100 character limit', () => {
  const name = deriveDirectory({ ...base, workspaceId: 'x'.repeat(200) })
  const directory = name.slice('/data/workspaces/'.length)
  assert.ok(directory.length <= MAX_DIRECTORY_NAME_LENGTH)
  assert.match(directory, /^cc-x+-[0-9a-f]{16}$/)
})

test('per-session requires a session id and includes it in the digest', () => {
  assert.throws(() => deriveDirectory({ ...base, strategy: 'per-session' }), /requires a session id/)
  const one = deriveDirectory({ ...base, strategy: 'per-session', sessionId: 's1' })
  const two = deriveDirectory({ ...base, strategy: 'per-session', sessionId: 's2' })
  assert.notEqual(one, two)
})

test('per-conversation is stable for one conversation', () => {
  const request = { ...base, strategy: 'per-conversation' as const, conversationId: 'conv-1' }
  assert.equal(deriveDirectory(request), deriveDirectory({ ...request, createdAt: 42 }))
  assert.throws(() => deriveDirectory({ ...base, strategy: 'per-conversation' }), /conversation id/)
})

test('host identity participates in the digest', () => {
  const local = deriveDirectory(base)
  const remote = deriveDirectory({ ...base, hostIdentity: 'ssh:devbox' })
  assert.notEqual(local, remote)
})

test('invalid prefixes are rejected', () => {
  assert.throws(() => deriveDirectory({ ...base, prefix: '' }), /must match/)
  assert.throws(() => deriveDirectory({ ...base, prefix: 'has space' }), /must match/)
})
