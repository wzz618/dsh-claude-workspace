import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRemoteCommand, quotePosix } from '../../src/host/shell.ts'
import { buildSshArgv } from '../../src/host/ssh.ts'

test('quotes spaces, quotes, substitutions, globs, and non-ASCII', () => {
  assert.equal(quotePosix('simple'), `'simple'`)
  assert.equal(quotePosix('with space'), `'with space'`)
  assert.equal(quotePosix("it's"), `'it'\\''s'`)
  assert.equal(quotePosix('$(rm -rf /)'), `'$(rm -rf /)'`)
  assert.equal(quotePosix('*.txt'), `'*.txt'`)
  assert.equal(quotePosix('/tmp/中文 目录'), `'/tmp/中文 目录'`)
  assert.equal(quotePosix(''), `''`)
})

test('remote commands quote every argument independently', () => {
  assert.equal(
    buildRemoteCommand(['mkdir', '-p', '--', '/tmp/a b']),
    `'mkdir' '-p' '--' '/tmp/a b'`,
  )
})

test('ssh argv uses batch mode, keepalive, and an explicit option terminator', () => {
  const argv = buildSshArgv(
    {
      alias: 'devbox',
      connectTimeoutMs: 8000,
      ssh: { connectTimeoutMs: 8000, serverAliveIntervalSec: 15, serverAliveCountMax: 3, strictHostKeyChecking: true },
    },
    `'claude-agent-acp'`,
  )
  assert.deepEqual(argv, [
    'ssh',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '--',
    'devbox',
    `'claude-agent-acp'`,
  ])
})

test('strict host key checking can be relaxed explicitly', () => {
  const argv = buildSshArgv(
    {
      alias: 'devbox',
      connectTimeoutMs: 1,
      ssh: { connectTimeoutMs: 1, serverAliveIntervalSec: 5, serverAliveCountMax: 2, strictHostKeyChecking: false },
    },
    'true',
  )
  assert.ok(argv.includes('StrictHostKeyChecking=no'))
  assert.ok(argv.includes('ConnectTimeout=1'))
})
