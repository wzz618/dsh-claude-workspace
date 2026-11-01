import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWidenRules,
  commandPrefix,
  describeTool,
  escapeRule,
  matchesWidenedRule,
} from '../../src/gate/widen.ts'

const cwd = '/work'

test('describes a Bash request from its stable name and raw input', () => {
  const tool = describeTool({
    toolCallId: 't1',
    title: 'Bash',
    name: 'Bash',
    kind: 'execute',
    rawInput: { command: 'npm test -- --watch' },
  })
  assert.equal(tool.toolName, 'Bash')
  assert.equal(tool.command, 'npm test -- --watch')
})

test('infers the tool name when the agent only sends a title', () => {
  assert.equal(describeTool({ toolCallId: 't', title: 'Write a.txt', kind: 'edit' }).toolName, 'Write')
  assert.equal(describeTool({ toolCallId: 't', title: 'Terminal', kind: 'execute' }).toolName, 'Bash')
})

test('command scope writes nothing because it forwards Claude\'s own option', () => {
  assert.deepEqual(buildWidenRules({ toolCallId: 't', title: 'Bash', name: 'Bash', rawInput: { command: 'npm test' } }, cwd, 'command'), {
    rules: [],
    notes: [],
  })
})

test('bash prefix and tool scopes produce the documented rule forms', () => {
  const tool = { toolCallId: 't', title: 'Bash', name: 'Bash', rawInput: { command: 'npm test -- --watch' } }
  assert.deepEqual(buildWidenRules(tool, cwd, 'prefix').rules, ['Bash(npm test:*)'])
  assert.deepEqual(buildWidenRules(tool, cwd, 'tool').rules, ['Bash'])
})

test('edit rules use paths relative to the session directory', () => {
  const tool = { toolCallId: 't', title: 'Edit', name: 'Edit', rawInput: { file_path: '/work/src/a.ts' } }
  assert.deepEqual(buildWidenRules(tool, cwd, 'prefix').rules, ['Edit(src/**)'])
  assert.deepEqual(buildWidenRules(tool, cwd, 'tool').rules, ['Edit'])
  const topLevel = { ...tool, rawInput: { file_path: '/work/a.ts' } }
  assert.deepEqual(buildWidenRules(topLevel, cwd, 'prefix').rules, ['Edit(**)'])
})

test('an edit outside the session directory cannot be widened', () => {
  assert.throws(
    () => buildWidenRules({ toolCallId: 't', title: 'Edit', name: 'Edit', rawInput: { file_path: '/elsewhere/a.ts' } }, cwd, 'prefix'),
    /outside the session directory/,
  )
})

test('read, fetch, and MCP rules follow the table', () => {
  const read = { toolCallId: 't', title: 'Read', name: 'Read', rawInput: { file_path: '/work/a.ts' } }
  assert.deepEqual(buildWidenRules(read, cwd, 'prefix').rules, ['Read(**)'])
  assert.deepEqual(buildWidenRules(read, cwd, 'tool').rules, ['Read'])

  const fetch = { toolCallId: 't', title: 'WebFetch', name: 'WebFetch', rawInput: { url: 'https://example.com/a' } }
  assert.deepEqual(buildWidenRules(fetch, cwd, 'prefix').rules, ['WebFetch(domain:example.com)'])
  assert.deepEqual(buildWidenRules(fetch, cwd, 'tool').rules, ['WebFetch'])

  const mcp = { toolCallId: 't', title: 'read', name: 'mcp__filesystem__read_file' }
  assert.deepEqual(buildWidenRules(mcp, cwd, 'prefix').rules, ['mcp__filesystem__read_file'])
  assert.deepEqual(buildWidenRules(mcp, cwd, 'tool').rules, ['mcp__filesystem'])
})

test('custom rules are taken verbatim', () => {
  assert.deepEqual(
    buildWidenRules({ toolCallId: 't', title: 'Bash', name: 'Bash' }, cwd, 'tool', 'Bash(ls)').rules,
    ['Bash(ls)'],
  )
})

test('escaping matches Claude\'s own rule writer', () => {
  assert.equal(escapeRule('python3 -c \'import time; time.sleep(1)\''), 'python3 -c \'import time; time\\.sleep\\(1\\)\'')
})

test('command prefixes use two tokens only for known multi-command tools', () => {
  assert.equal(commandPrefix('npm test -- --watch'), 'npm test')
  assert.equal(commandPrefix('git status --short'), 'git status')
  assert.equal(commandPrefix('python3 -c "print(1)"'), 'python3')
  assert.equal(commandPrefix('ls -la'), 'ls')
  assert.equal(commandPrefix('  echo   hello  '), 'echo')
})

test('remembered rules auto-allow only matching calls', () => {
  const bash = (command: string) => ({ toolCallId: 't', title: 'Bash', name: 'Bash', rawInput: { command } })
  assert.equal(matchesWidenedRule('Bash(npm test:*)', bash('npm test -- --watch'), cwd), true)
  assert.equal(matchesWidenedRule('Bash(npm test:*)', bash('npm run build'), cwd), false)
  assert.equal(matchesWidenedRule("Bash(echo \\(x\\))", bash('echo (x)'), cwd), true)
  assert.equal(matchesWidenedRule('Bash', bash('anything'), cwd), true)

  const edit = (path: string) => ({ toolCallId: 't', title: 'Edit', name: 'Edit', rawInput: { file_path: path } })
  assert.equal(matchesWidenedRule('Edit(**)', edit('/work/any.ts'), cwd), true)
  assert.equal(matchesWidenedRule('Edit(src/**)', edit('/work/src/a.ts'), cwd), true)
  assert.equal(matchesWidenedRule('Edit(src/**)', edit('/work/lib/a.ts'), cwd), false)
  assert.equal(matchesWidenedRule('Edit(**)', { toolCallId: 't', title: 'Bash', name: 'Bash' }, cwd), false)

  const fetch = { toolCallId: 't', title: 'WebFetch', name: 'WebFetch', rawInput: { url: 'https://example.com/a' } }
  assert.equal(matchesWidenedRule('WebFetch(domain:example.com)', fetch, cwd), true)
  assert.equal(matchesWidenedRule('WebFetch(domain:other.com)', fetch, cwd), false)

  const mcp = { toolCallId: 't', title: 'read', name: 'mcp__filesystem__read_file' }
  assert.equal(matchesWidenedRule('mcp__filesystem', mcp, cwd), true)
  assert.equal(matchesWidenedRule('mcp__other', mcp, cwd), false)
})
