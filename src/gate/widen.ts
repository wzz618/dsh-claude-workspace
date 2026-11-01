import { posix } from 'node:path'
import type { ToolCallUpdate } from '../acp/types.ts'
import type { WidenScope } from '../config.ts'
import { CcwError } from '../util/errors.ts'

/** Fields the rule generator reads from one tool call. */
export interface ToolDescription {
  /** Rule-facing tool name, for example `Bash`, `Edit`, or `mcp__server__tool`. */
  readonly toolName: string
  readonly kind: string
  readonly command?: string
  readonly path?: string
  readonly url?: string
  readonly mcpServer?: string
  readonly mcpTool?: string
}

/** Generated allow rules plus caveats the UI must show. */
export interface WidenRules {
  readonly rules: readonly string[]
  readonly notes: readonly string[]
}

/**
 * Names the tool behind one permission request.
 *
 * ACP titles change during a tool's life (`Preparing file…` becomes
 * `Write path`), so the stable `name` field wins when present. Otherwise the
 * kind supplies a conservative built-in name.
 *
 * @param toolCall - Tool call carried by the permission request.
 * @returns The tool name and the arguments a rule can be derived from.
 */
export function describeTool(toolCall: ToolCallUpdate): ToolDescription {
  const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : {}
  const command = stringOf(raw.command) ?? stringOf(raw.cmd)
  const path = stringOf(raw.file_path) ?? stringOf(raw.path) ?? stringOf(raw.notebook_path) ?? toolCall.locations?.[0]?.path
  const url = stringOf(raw.url)
  const explicit = typeof toolCall.name === 'string' && toolCall.name.length > 0 ? toolCall.name : undefined
  const title = toolCall.title ?? ''
  const inferred = explicit ?? inferFromTitle(title) ?? inferFromKind(toolCall.kind)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(inferred)
  return {
    toolName: inferred,
    kind: toolCall.kind ?? 'other',
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { path }),
    ...(url === undefined ? {} : { url }),
    ...(mcp === null ? {} : { mcpServer: mcp[1]!, mcpTool: mcp[2]! }),
  }
}

/**
 * Builds the rule text a "widen" choice would write.
 *
 * `command` scope writes nothing: it is exactly Claude's own
 * `allow-with-updates` suggestion, so CCW forwards that option instead of
 * duplicating Claude's persistence logic. `prefix` and `tool` are CCW-written
 * rules and are returned for display before anything is written.
 *
 * @param toolCall - Permission request's tool call.
 * @param cwd - Session working directory; Claude rules use relative paths.
 * @param scope - Requested widen scope.
 * @param customRule - Optional user-edited rule, validated only for non-emptiness.
 * @returns Rules and notes to show in the confirmation.
 * @throws {CcwError} When a safe rule cannot be derived.
 */
export function buildWidenRules(
  toolCall: ToolCallUpdate,
  cwd: string,
  scope: WidenScope,
  customRule?: string,
): WidenRules {
  if (customRule !== undefined) {
    const trimmed = customRule.trim()
    if (trimmed.length === 0) throw new CcwError('widen-unsupported', 'custom rule cannot be blank')
    return { rules: [trimmed], notes: ['custom rule; review it before saving'] }
  }
  if (scope === 'command') return { rules: [], notes: [] }
  const tool = describeTool(toolCall)
  const notes: string[] = []

  if (tool.toolName.startsWith('mcp__')) {
    if (tool.mcpServer === undefined) {
      throw new CcwError('widen-unsupported', `cannot widen unknown MCP tool "${tool.toolName}"`, { tool: tool.toolName })
    }
    return {
      rules: [scope === 'tool' ? `mcp__${tool.mcpServer}` : tool.toolName],
      notes: scope === 'tool' ? [`grants every tool from MCP server "${tool.mcpServer}"`] : [],
    }
  }

  const name = normalizeToolName(tool.toolName)
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      if (scope === 'tool') return { rules: [name], notes: [`grants every ${name} command`] }
      const command = tool.command
      if (command === undefined || command.trim().length === 0) {
        throw new CcwError('widen-unsupported', 'cannot derive a command prefix: the request carries no command', {
          tool: name,
        })
      }
      const prefix = commandPrefix(command)
      if (prefix !== command.trim()) notes.push(`prefix rule matches commands starting with "${prefix}"`)
      return { rules: [`${name}(${escapeRule(prefix)}:*)`], notes }
    }
    case 'Edit': {
      if (scope === 'tool') return { rules: ['Edit'], notes: ['grants Edit and Write for every file'] }
      const relative = relativePath(tool.path, cwd)
      if (relative === undefined) {
        throw new CcwError('widen-unsupported', 'cannot widen an edit outside the session directory; use Claude\'s own option', {
          path: tool.path,
          cwd,
        })
      }
      const directory = posix.dirname(relative)
      if (directory === '.' || directory === '') {
        return { rules: ['Edit(**)'], notes: ['grants Edit and Write for every file in the session'] }
      }
      return { rules: [`Edit(${escapeRule(directory)}/**)`], notes: [`grants Edit and Write under ${directory}/`] }
    }
    case 'Read': {
      if (scope === 'tool') return { rules: ['Read'], notes: ['grants Read, Glob, and Grep'] }
      return { rules: ['Read(**)'], notes: ['grants reads anywhere in the session'] }
    }
    case 'WebFetch': {
      if (scope === 'tool') return { rules: ['WebFetch'], notes: ['grants every web fetch'] }
      const host = urlHost(tool.url)
      if (host === undefined) {
        throw new CcwError('widen-unsupported', 'cannot derive a fetch domain: the request carries no URL', {
          tool: name,
        })
      }
      return { rules: [`WebFetch(domain:${host})`], notes: [`grants fetches from ${host}`] }
    }
    default:
      if (scope === 'prefix') {
        throw new CcwError('widen-unsupported', `tool "${name}" has no prefix rule form`, { tool: name })
      }
      return { rules: [name], notes: [`grants every ${name} call`] }
  }
}

/**
 * Escapes metacharacters the way Claude's own rule writer does.
 *
 * Claude stores `time.sleep\(1\)` for a command containing parentheses, so a
 * CCW-written rule must use the same escaping or it will not match.
 *
 * @param text - Raw rule fragment.
 * @returns The fragment with regex metacharacters backslash-escaped.
 */
export function escapeRule(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * Tests whether a rule written earlier in this session covers a new request.
 *
 * Matching is intentionally conservative: an unrecognized rule form never
 * auto-allows. The in-memory session rules use the same text that was written
 * to settings, so the match mirrors the agent's own rule shape.
 *
 * @param rule - Rule text, for example `Bash(npm test:*)`.
 * @param toolCall - New permission request's tool call.
 * @param cwd - Session working directory.
 * @returns True when the rule covers the call.
 */
export function matchesWidenedRule(rule: string, toolCall: ToolCallUpdate, cwd: string): boolean {
  const parsed = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(rule.trim())
  if (parsed === null) return false
  const ruleName = parsed[1]!
  const argument = parsed[2]
  const tool = describeTool(toolCall)
  const toolName = normalizeToolName(tool.toolName)

  if (ruleName.startsWith('mcp__')) {
    if (tool.toolName !== ruleName && !tool.toolName.startsWith(`${ruleName}__`)) return false
    return argument === undefined
  }
  if (normalizeToolName(ruleName) !== toolName) return false
  if (argument === undefined) return true

  const unescaped = unescapeRule(argument)
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const command = tool.command?.trim()
      if (command === undefined) return false
      if (unescaped.endsWith(':*')) return command.startsWith(unescaped.slice(0, -2))
      return command === unescaped
    }
    case 'Edit': {
      if (unescaped === '**') return true
      const relative = relativePath(tool.path, cwd)
      if (relative === undefined) return false
      if (unescaped.endsWith('/**')) return relative.startsWith(unescaped.slice(0, -3))
      return relative === unescaped || posix.normalize(relative) === posix.normalize(unescaped)
    }
    case 'Read':
      return unescaped === '**' || (() => {
        const relative = relativePath(tool.path, cwd)
        return relative !== undefined && relative === unescaped
      })()
    case 'WebFetch': {
      const host = urlHost(tool.url)
      if (host === undefined) return false
      if (unescaped.startsWith('domain:')) return host === unescaped.slice('domain:'.length)
      return unescaped === '**'
    }
    default:
      return false
  }
}

/** Reverses `escapeRule` for rules read back from settings. */
export function unescapeRule(text: string): string {
  return text.replace(/\\([\\^$.*+?()[\]{}|])/g, '$1')
}

/**
 * Heuristic command prefix used by the prefix scope.
 *
 * Package managers and version-control commands are represented by their first
 * two tokens (`npm test`, `git status`); everything else uses the first token.
 * The generated rule is always shown before writing because this is a
 * heuristic, not a shell parser.
 *
 * @param command - Full command line.
 * @returns The prefix text, without the trailing `:*`.
 */
export function commandPrefix(command: string): string {
  const tokens = tokenize(command)
  if (tokens.length === 0) return command.trim()
  const first = tokens[0]!
  const second = tokens[1]
  if (second !== undefined && MULTI_TOKEN_COMMANDS.has(first) && !second.startsWith('-')) {
    return `${first} ${second}`
  }
  return first
}

const MULTI_TOKEN_COMMANDS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'git', 'docker', 'kubectl', 'make', 'uv', 'poetry', 'pip', 'pip3',
])

function normalizeToolName(name: string): string {
  switch (name) {
    case 'Write':
    case 'NotebookEdit':
    case 'MultiEdit':
      return 'Edit'
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'Read'
    case 'WebSearch':
    case 'Fetch':
      return 'WebFetch'
    default:
      return name
  }
}

function inferFromTitle(title: string): string | undefined {
  const first = title.trim().split(/\s+/)[0]
  if (first === undefined) return undefined
  if (first === 'Terminal') return 'Bash'
  const known = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
  return known.has(first) ? first : undefined
}

function inferFromKind(kind: string | undefined): string {
  switch (kind) {
    case 'execute':
      return 'Bash'
    case 'edit':
    case 'delete':
    case 'move':
      return 'Edit'
    case 'read':
    case 'search':
      return 'Read'
    case 'fetch':
      return 'WebFetch'
    default:
      return 'UnknownTool'
  }
}

function relativePath(path: string | undefined, cwd: string): string | undefined {
  if (path === undefined || path.length === 0) return undefined
  if (!path.startsWith('/')) return posix.normalize(path)
  const normalizedCwd = posix.normalize(cwd).replace(/\/+$/, '')
  if (path === normalizedCwd) return '.'
  if (!path.startsWith(`${normalizedCwd}/`)) return undefined
  return path.slice(normalizedCwd.length + 1)
}

function urlHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaping = false
  for (const character of command.trim()) {
    if (escaping) {
      current += character
      escaping = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
