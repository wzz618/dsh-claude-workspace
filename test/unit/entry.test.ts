import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { apply, Config, inject, name } from '../../src/index.ts'
import { CCW_HTTP_PATHS, type ExactRoute } from '../../src/http.ts'
import { makeTempDir, removeTempDir } from '../helpers/temp.ts'

test('exports the function-plugin shape Cordis expects', () => {
  assert.equal(name, 'dsh-claude-workspace')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
})

test('Config rejects invalid input and accepts an empty map', () => {
  const validator = Config['~standard']
  const empty = validator.validate({})
  assert.ok('value' in empty)
  const invalid = validator.validate({ unknown: true })
  assert.ok('issues' in invalid)
  assert.ok(invalid.issues.length > 0)
})

test('apply registers every HTTP route and disposes the service', async () => {
  const dataDir = await makeTempDir()
  try {
    const routes: ExactRoute[] = []
    let dispose: (() => void) | undefined
    const ctx = {
      get: () => undefined,
      inject: (names: readonly string[], callback: (scope: Record<string, unknown>) => void) => {
        if (names.includes('webServer')) {
          callback({ webServer: { register: (route: ExactRoute) => routes.push(route) } })
          return
        }
        callback({})
      },
      effect: (callback: () => () => void) => {
        dispose = callback()
      },
      logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
    }
    apply(ctx, { dataDir, workspaces: { baseDir: join(dataDir, 'workspaces') } })
    assert.equal(routes.length, CCW_HTTP_PATHS.length)
    assert.deepEqual(routes.map((route) => route.path), [...CCW_HTTP_PATHS])
    assert.ok(routes.every((route) => route.kind === 'exact'))
    assert.equal(typeof dispose, 'function')
    dispose!()
  } finally {
    await removeTempDir(dataDir)
  }
})

test('apply works without a web server and without a workspace controller', async () => {
  const dataDir = await makeTempDir()
  try {
    const warnings: string[] = []
    const ctx = {
      get: () => undefined,
      logger: () => ({
        info: () => undefined,
        warn: (message: string) => warnings.push(message),
        error: () => undefined,
      }),
    }
    apply(ctx, { dataDir })
    assert.ok(warnings.some((message) => message.includes('webServer')))
  } finally {
    await removeTempDir(dataDir)
  }
})
