import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines } from '../../src/acp/diff.ts'

test('reports additions and removals with line numbers', () => {
  const result = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')
  assert.equal(result.truncated, false)
  assert.equal(result.added, 2)
  assert.equal(result.removed, 1)
  const lines = result.hunks.flatMap((hunk) => hunk.lines)
  assert.deepEqual(lines.map((line) => `${line.kind}:${line.text}`), [
    'context:a',
    'remove:b',
    'add:B',
    'context:c',
    'add:d',
  ])
})

test('separates distant changes into hunks with context', () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
  const after = before.replace('line 1\n', 'line one\n').replace('line 18', 'line eighteen')
  const result = diffLines(before, after, 1)
  assert.equal(result.hunks.length, 2)
  assert.equal(result.added, 2)
  assert.equal(result.removed, 2)
})

test('identical text produces no hunks', () => {
  const result = diffLines('same\n', 'same\n')
  assert.deepEqual(result, { added: 0, removed: 0, hunks: [], truncated: false })
})

test('oversized inputs return counts only', () => {
  const oldText = Array.from({ length: 1200 }, () => 'x').join('\n')
  const newText = Array.from({ length: 1200 }, () => 'y').join('\n')
  const result = diffLines(oldText, newText)
  assert.equal(result.truncated, true)
  assert.equal(result.hunks.length, 0)
  assert.equal(result.added, 1200)
  assert.equal(result.removed, 1200)
})

test('an empty old file is a pure addition', () => {
  const result = diffLines('', 'hello\n')
  assert.equal(result.added, 1)
  assert.equal(result.removed, 0)
})
