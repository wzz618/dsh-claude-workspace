import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../../src/config.ts'
import { localNativeProvider, nativeAgentIdForHost, nativeProviderForHost, sanitizeAgentId } from '../../src/native/routing.ts'

const config = resolveConfig({
  hosts: {
    local: { kind: 'local' },
    'GPU_1': { kind: 'ssh', alias: 'gpu1' },
    'gpu-1': { kind: 'ssh', alias: 'gpu1b' },
    '9box': { kind: 'ssh', alias: 'nine' },
  },
})

test('the local host keeps the configured provider', () => {
  assert.equal(localNativeProvider(config), 'acp-claude-code')
  assert.equal(nativeProviderForHost(config, 'local'), 'acp-claude-code')
  assert.equal(nativeProviderForHost(config, 'missing'), 'acp-claude-code')
})

test('ssh hosts get deterministic, unique, grammar-valid agent ids', () => {
  assert.equal(nativeAgentIdForHost(config, 'GPU_1'), 'claude-code-gpu-1')
  assert.equal(nativeAgentIdForHost(config, 'gpu-1'), 'claude-code-gpu-1-2')
  assert.equal(nativeProviderForHost(config, '9box'), 'acp-claude-code-h-9box')
  for (const hostId of ['GPU_1', 'gpu-1', '9box']) {
    assert.match(nativeAgentIdForHost(config, hostId), /^[a-z][a-z0-9-]*$/)
  }
})

test('sanitization reduces punctuation and keeps a leading letter', () => {
  assert.equal(sanitizeAgentId('My Host!!'), 'my-host')
  assert.equal(sanitizeAgentId('--x--'), 'x')
  assert.equal(sanitizeAgentId('42'), 'h-42')
})
