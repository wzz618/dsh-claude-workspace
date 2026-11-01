#!/usr/bin/env node
// Programmable ACP server used by integration tests. It speaks NDJSON
// JSON-RPC on stdio and never touches the real Claude Code installation.
//
// Scenarios:
//   perm  (default) — edit tool with a diff and a permission request
//   bash            — execute tool, prefix-widen scenarios
//   slow            — prompt stays running until session/cancel
//   load            — session/load replays two historical updates
import { createInterface } from 'node:readline'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv.includes('--version')) {
  process.stdout.write('0.99.1\n')
  process.exit(0)
}

const requestedScenario = process.argv[2] || 'perm'
let scenario = requestedScenario

// `die` and `die-pending` model one crashed process per workspace: the first
// process leaves a marker and exits mid-turn; the process started after the
// marker exists removes it and behaves like `perm`, so reconnect tests can
// recover on the next spawn.
if (requestedScenario === 'die' || requestedScenario === 'die-pending') {
  const marker = join(process.cwd(), '.ccw-die-marker')
  if (existsSync(marker)) {
    rmSync(marker)
    scenario = 'perm'
  } else {
    writeFileSync(marker, '1')
    scenario = requestedScenario
  }
}
const sessions = new Map()
const activePrompts = new Map()
const planEmitted = new Set()
let nextServerId = 1000
let sessionCounter = 0
const pendingServer = new Map()

const modesState = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'acceptEdits', name: 'Accept edits' },
    { id: 'plan', name: 'Plan' },
  ],
}

const permissionOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-updates', name: "Yes, and don't ask again", kind: 'allow_with_updates' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

function permissionRequest(sessionId, cwd, title = 'Write a.txt') {
  return {
    sessionId,
    toolCall: {
      toolCallId: 't1',
      title,
      kind: 'edit',
      rawInput: { file_path: join(cwd, 'a.txt'), content: 'hello' },
    },
    options: permissionOptions,
  }
}

const configOptions = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'sonnet',
    options: [
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'acceptEdits', name: 'Accept edits' },
    ],
  },
]

const rl = createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function respondError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32603, message } })
}
function notify(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}
function request(method, params) {
  const id = nextServerId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve) => pendingServer.set(id, resolve))
}

function finishPrompt(promptId, result) {
  const sessionId = activePrompts.get(promptId)
  if (sessionId === undefined) return
  activePrompts.delete(promptId)
  const timer = promptTimers.get(promptId)
  if (timer !== undefined) {
    clearTimeout(timer)
    promptTimers.delete(promptId)
  }
  respond(promptId, result)
}

const promptTimers = new Map()

async function runTurn(promptId, sessionId) {
  const session = sessions.get(sessionId)
  const cwd = session.cwd
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from fake' } })
  const isBash = scenario === 'bash'
  const kind = isBash ? 'execute' : 'edit'
  const title = isBash ? 'Bash' : 'Preparing file…'
  const finalTitle = isBash ? 'Bash' : 'Write a.txt'
  const rawInput = isBash ? { command: 'npm test -- --watch' } : { file_path: join(cwd, 'a.txt'), content: 'hello' }
  const content = isBash
    ? [{ type: 'content', content: { type: 'text', text: 'running' } }]
    : [{ type: 'diff', path: join(cwd, 'a.txt'), oldText: '', newText: 'hello\n' }]
  notify(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title,
    kind,
    status: 'in_progress',
    content,
    rawInput,
  })
  notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: finalTitle, status: 'in_progress' })
  const answer = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 't1', title: finalTitle, kind, rawInput },
    options: permissionOptions,
  })
  const optionId = answer?.outcome?.optionId
  if (typeof optionId !== 'string' || optionId.startsWith('reject')) {
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' })
  } else {
    if (!isBash) writeFileSync(join(cwd, 'a.txt'), 'hello\n')
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
  }
  finishPrompt(promptId, { stopReason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } })
}

function startPrompt(promptId, sessionId) {
  activePrompts.set(promptId, sessionId)
  const session = sessions.get(sessionId)
  const cwd = session === undefined ? process.cwd() : session.cwd
  if (scenario === 'die' || scenario === 'die-pending') {
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to crash' } })
    const pending = request('session/request_permission', permissionRequest(sessionId, cwd, 'Write a.txt'))
    if (scenario === 'die') {
      void pending.then(() => {
        setTimeout(() => process.exit(0), 100)
      })
    } else {
      setTimeout(() => process.exit(0), 400)
    }
    return
  }
  if (scenario === 'plan' && !planEmitted.has(sessionId)) {
    planEmitted.add(sessionId)
    notify(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'inspect the repository', priority: 'high', status: 'completed' },
        { content: 'write the patch', priority: 'medium', status: 'pending' },
      ],
    })
    finishPrompt(promptId, { stopReason: 'end_turn' })
    return
  }
  if (scenario === 'slow') {
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } })
    promptTimers.set(promptId, setTimeout(() => finishPrompt(promptId, { stopReason: 'end_turn' }), 60_000))
    return
  }
  void runTurn(promptId, sessionId)
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pendingServer.get(message.id)
    pendingServer.delete(message.id)
    if (resolve) resolve(message.result ?? {})
    return
  }
  if (message.method === undefined) return
  if (message.id === undefined) {
    if (message.method === 'session/cancel') {
      for (const [promptId, sessionId] of activePrompts.entries()) {
        if (sessionId === message.params.sessionId) finishPrompt(promptId, { stopReason: 'cancelled' })
      }
    }
    return
  }
  try {
    switch (message.method) {
      case 'initialize':
        respond(message.id, {
          protocolVersion: 1,
          agentInfo: { name: 'fake-claude-agent-acp', version: '0.99.1' },
          agentCapabilities: { loadSession: true },
        })
        break
      case 'session/new': {
        const sessionId = `acp-session-${(sessionCounter += 1)}`
        sessions.set(sessionId, { cwd: message.params.cwd })
        respond(message.id, {
          sessionId,
          modes: modesState,
          configOptions,
        })
        break
      }
      case 'session/load': {
        const sessionId = message.params.sessionId
        sessions.set(sessionId, { cwd: message.params.cwd })
        notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'previous answer' } })
        notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't-old', title: 'Read file', kind: 'read', status: 'completed' })
        respond(message.id, { modes: modesState, configOptions })
        break
      }
      case 'session/prompt':
        startPrompt(message.id, message.params.sessionId)
        break
      case 'session/set_config_option':
      case 'session/set_mode':
        respond(message.id, {})
        break
      default:
        respondError(message.id, `unsupported method ${message.method}`)
    }
  } catch (error) {
    respondError(message.id, String(error))
  }
})

// Keep the process alive while stdin is open.
process.stdin.resume()
