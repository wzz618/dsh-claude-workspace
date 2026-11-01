import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createCcwHttpHandler } from '../../src/http.ts'
import { createService } from '../../src/service.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

async function listen(service: ReturnType<typeof createService>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(createCcwHttpHandler(service))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${address.port}/api/dsh-claude-workspace`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface ApiBody {
  ok: boolean
  data?: {
    defaultHost?: string
    registryAvailable?: boolean
    workspace?: { title?: string }
    workspaces?: unknown[]
    plan?: unknown
  }
  error?: { code?: string }
}

async function jsonOf(response: Response): Promise<ApiBody> {
  return (await response.json()) as ApiBody
}

test('serves status, creates workspaces, and reports validation errors', async () => {
  const dataDir = await makeTempDir()
  const service = createService({
    config: {
      dataDir,
      hosts: { local: { kind: 'local' } },
      workspaces: { baseDir: join(dataDir, 'workspaces') },
    },
  })
  const http = await listen(service)
  try {
    const status = await jsonOf(await fetch(`${http.base}/status`))
    assert.equal(status.ok, true)
    assert.equal(status.data!.defaultHost, 'local')
    assert.equal(status.data!.registryAvailable, false)

    const created = await jsonOf(await fetch(`${http.base}/workspaces/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: 'local', title: 'Demo' }),
    }))
    assert.equal(created.ok, true)
    assert.equal(created.data!.workspace!.title, 'Demo')

    const listed = await jsonOf(await fetch(`${http.base}/workspaces`))
    assert.equal(listed.data!.workspaces!.length, 1)

    const invalid = await fetch(`${http.base}/workspaces/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'missing host' }),
    })
    assert.equal(invalid.status, 400)
    const body = await jsonOf(invalid)
    assert.equal(body.ok, false)
    assert.equal(body.error!.code, 'config-invalid')

    const missing = await jsonOf(await fetch(`${http.base}/plans?dshSessionId=unknown`))
    assert.equal(missing.data!.plan, null)
  } finally {
    await http.close()
    await service.close()
    await removeTempDir(dataDir)
  }
})
