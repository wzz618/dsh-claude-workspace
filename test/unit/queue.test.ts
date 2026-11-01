import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SerialQueue } from '../../src/util/queue.ts'

test('tasks for one key run strictly in order', async () => {
  const queue = new SerialQueue()
  const order: number[] = []
  await Promise.all([
    queue.run('k', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(1)
    }),
    queue.run('k', () => {
      order.push(2)
    }),
    queue.run('k', () => {
      order.push(3)
    }),
  ])
  assert.deepEqual(order, [1, 2, 3])
})

test('different keys run independently', async () => {
  const queue = new SerialQueue()
  const order: string[] = []
  await Promise.all([
    queue.run('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('a')
    }),
    queue.run('b', () => {
      order.push('b')
    }),
  ])
  assert.deepEqual(order, ['b', 'a'])
})

test('a failed task does not poison later tasks', async () => {
  const queue = new SerialQueue()
  await assert.rejects(queue.run('k', () => {
    throw new Error('boom')
  }), /boom/)
  assert.equal(await queue.run('k', () => 'after'), 'after')
})

test('drain waits for queued work and releases keys', async () => {
  const queue = new SerialQueue()
  let done = false
  void queue.run('k', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    done = true
  })
  await queue.drain()
  assert.equal(done, true)
  assert.equal(await queue.run('k', () => 'fresh'), 'fresh')
})
