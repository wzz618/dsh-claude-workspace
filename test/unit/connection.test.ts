import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { AcpConnection, type CloseReason } from '../../src/acp/connection.ts'
import { keepAlive } from '../helpers/temp.ts'

interface Harness {
  connection: AcpConnection
  server: PassThrough
  receive: () => Promise<Record<string, unknown>>
  writes: Record<string, unknown>[]
  closes: CloseReason[]
}

function harness(onRequest?: (method: string, params: unknown) => unknown, onNotification?: (method: string, params: unknown) => void): Harness {
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const writes: Record<string, unknown>[] = []
  const closes: CloseReason[] = []
  toServer.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue
      writes.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  const connection = new AcpConnection(
    { stdin: toServer, stdout: toClient },
    {
      maxLineBytes: 1024,
      ...(onRequest === undefined ? {} : { onRequest }),
      ...(onNotification === undefined ? {} : { onNotification }),
      onClose: (reason) => closes.push(reason),
    },
  )
  return {
    connection,
    server: toClient,
    writes,
    closes,
    receive: async () => {
      for (;;) {
        if (writes.length > 0) return writes.shift()!
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
  }
}

test('a request is written as one JSON line and resolves with the result', async () => {
  const h = harness()
  const pending = h.connection.request<{ ok: boolean }>('initialize', { protocolVersion: 1 }, 1000)
  const message = await h.receive()
  assert.equal(message.method, 'initialize')
  assert.equal(typeof message.id, 'number')
  h.server.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n`)
  assert.deepEqual(await pending, { ok: true })
  h.connection.dispose()
})

test('responses split across chunks and CRLF are reassembled', async () => {
  const h = harness()
  const pending = h.connection.request('session/new', {}, 1000)
  const message = await h.receive()
  const text = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1' } })
  h.server.write(text.slice(0, 10))
  h.server.write(`${text.slice(10)}\r\n`)
  assert.deepEqual(await pending, { sessionId: 's1' })
  h.connection.dispose()
})

test('notifications reach the handler without a response', async () => {
  const seen: unknown[] = []
  const h = harness(undefined, (method, params) => seen.push({ method, params }))
  h.server.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'plan' } } })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen, [{ method: 'session/update', params: { update: { sessionUpdate: 'plan' } } }])
  h.connection.dispose()
})

test('agent requests are answered by the handler', async () => {
  const h = harness((method) => {
    assert.equal(method, 'session/request_permission')
    return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  })
  h.server.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'session/request_permission', params: {} })}\n`)
  const response = await h.receive()
  assert.equal(response.id, 'server-1')
  assert.deepEqual(response.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
  h.connection.dispose()
})

test('a handler failure becomes a JSON-RPC error response', async () => {
  const h = harness(() => {
    throw new Error('nope')
  })
  h.server.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} })}\n`)
  const response = await h.receive()
  assert.deepEqual(response.error, { code: -32603, message: 'nope' })
  h.connection.dispose()
})

test('invalid JSON closes the connection and rejects pending requests', async () => {
  const h = harness()
  const pending = h.connection.request('initialize', {}, 1000)
  await h.receive()
  h.server.write('not json\n')
  await assert.rejects(pending, /ACP connection closed/)
  const close = h.closes[0]
  assert.equal(close?.kind, 'protocol-error')
  assert.ok(close?.kind === 'protocol-error' && close.message.includes('invalid JSON'))
})

test('an oversized line closes the connection', async () => {
  const h = harness()
  h.server.write(`${'x'.repeat(2000)}\n`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.closes.length, 1)
  assert.equal(h.closes[0]!.kind, 'protocol-error')
})

test('closing rejects a pending request with a timeout or disconnect', async () => {
  const h = harness()
  const pending = h.connection.request('session/prompt', {}, 20)
  await h.receive()
  await assert.rejects(keepAlive(pending), /timed out|closed/)
  h.connection.dispose()
})

test('stdout end reports EOF once', async () => {
  const h = harness()
  h.server.end()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(h.closes, [{ kind: 'eof' }])
  h.connection.dispose()
})
