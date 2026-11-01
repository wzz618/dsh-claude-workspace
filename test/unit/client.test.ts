import { test } from 'node:test'
import assert from 'node:assert/strict'

interface LoaderDefinition {
  id: string
  factory(requireModule: (name: string) => unknown): Record<string, unknown>
}

const globals = globalThis as typeof globalThis & {
  window?: { __ModuleLoader__?: { load(definition: LoaderDefinition): void } }
}
let captured: LoaderDefinition | undefined
globals.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
const clientModule = new URL('../../src/client.js', import.meta.url).href
await import(clientModule)

/** Minimal host-provided modules the browser factory requires. */
function fakeRequire(name: string): unknown {
  if (name === 'react') {
    return {
      Fragment: 'Fragment',
      useState: (initial: unknown) => [initial, () => undefined],
      useEffect: () => undefined,
      useCallback: (callback: unknown) => callback,
      useRef: (initial: unknown) => ({ current: initial }),
    }
  }
  if (name === 'react/jsx-runtime') return { jsx: () => null }
  throw new Error(`unexpected module ${name}`)
}

const client = captured!.factory(fakeRequire)
const mergeEvents = client.mergeEvents as (a: unknown[], b: unknown[], n: number) => unknown[]
const groupEvents = client.groupEvents as (a: unknown[]) => unknown[]
const flattenSelectValues = client.flattenSelectValues as (a: unknown[]) => { value: string; name: string }[]
const toolInputSummary = client.toolInputSummary as (a: unknown) => string
const latestCommands = client.latestCommands as (events: unknown[]) => { name: string; description?: string }[]
const matchCommands = client.matchCommands as (commands: unknown[], draft: string) => { name: string }[]
const autoApprovals = client.autoApprovals as (events: unknown[]) => Record<string, string>
const relativeWithin = client.relativeWithin as (root: string, path: string) => string
const parentDirectory = client.parentDirectory as (directory: string, root: string) => string

test('the module registers under the client id and exports the plugin shape', () => {
  assert.equal(captured?.id, 'dsh-claude-workspace')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(typeof client.SettingsSection, 'function')
})

test('mergeEvents dedupes by seq and keeps the newest tail', () => {
  const merged = mergeEvents(
    [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }],
    [{ seq: 2, text: 'b' }, { seq: 3, text: 'c' }],
    3,
  )
  assert.deepEqual(merged.map((event) => (event as { seq: number }).seq), [1, 2, 3])
  const trimmed = mergeEvents([{ seq: 1 }, { seq: 2 }], [{ seq: 3 }], 2)
  assert.deepEqual(trimmed.map((event) => (event as { seq: number }).seq), [2, 3])
})

test('groupEvents merges adjacent text chunks of the same kind and replay state', () => {
  const groups = groupEvents([
    { type: 'assistant-text', replay: false, seq: 1, text: 'Hel' },
    { type: 'assistant-text', replay: false, seq: 2, text: 'lo' },
    { type: 'thinking', replay: false, seq: 3, text: 'hmm' },
    { type: 'assistant-text', replay: true, seq: 4, text: 'old' },
    { type: 'tool-call', replay: true, seq: 5, card: { toolCallId: 't' } },
  ])
  assert.equal(groups.length, 4)
  assert.equal((groups[0] as { text: string }).text, 'Hello')
  assert.equal((groups[1] as { type: string }).type, 'thinking')
  assert.equal((groups[3] as { type: string }).type, 'tool-call')
})

test('flattenSelectValues handles flat and grouped option lists', () => {
  const values = flattenSelectValues([
    { value: 'sonnet', name: 'Sonnet' },
    { group: 'g', name: 'Group', options: [{ value: 'opus', name: 'Opus' }] },
  ])
  assert.deepEqual(values, [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }])
})

test('toolInputSummary prefers command, then path, then URL, and clips long values', () => {
  assert.equal(toolInputSummary({ rawInput: { command: 'npm test' } }), 'npm test')
  assert.equal(toolInputSummary({ rawInput: { file_path: '/w/a.ts' } }), '/w/a.ts')
  assert.equal(toolInputSummary({ rawInput: { url: 'https://example.com' } }), 'https://example.com')
  assert.equal(toolInputSummary({ locations: [{ path: '/w/b.ts' }] }), '/w/b.ts')
  assert.equal(toolInputSummary({ rawInput: { command: 'x'.repeat(400) } }).length, 220)
  assert.equal(toolInputSummary(null), '')
})

test('latestCommands reads the newest commands event', () => {
  const commands = [{ name: 'compact', description: 'Compact' }]
  assert.deepEqual(latestCommands([
    { type: 'commands', seq: 1, commands: [{ name: 'old' }] },
    { type: 'assistant-text', seq: 2 },
    { type: 'commands', seq: 3, commands },
  ]), commands)
  assert.deepEqual(latestCommands([]), [])
})

test('matchCommands filters slash commands by prefix', () => {
  const commands = [{ name: 'compact' }, { name: 'clear' }, { name: 'review' }]
  assert.deepEqual(matchCommands(commands, '/c').map((command) => command.name), ['compact', 'clear'])
  assert.deepEqual(matchCommands(commands, '/re').map((command) => command.name), ['review'])
  assert.deepEqual(matchCommands(commands, 'hello'), [])
  assert.deepEqual(matchCommands(commands, '/z'), [])
})

test('relativeWithin and parentDirectory stay under the picker root', () => {
  assert.equal(relativeWithin('/w/project', '/w/project/src/a.ts'), 'src/a.ts')
  assert.equal(relativeWithin('/w/project', '/w/project'), '.')
  assert.equal(relativeWithin('/w/project', '/elsewhere/a.ts'), '/elsewhere/a.ts')
  assert.equal(parentDirectory('/w/project/src/deep', '/w/project'), '/w/project/src')
  assert.equal(parentDirectory('/w/project', '/w/project'), '/w/project')
  assert.equal(parentDirectory('/w/project/src', '/w/project'), '/w/project')
})

test('autoApprovals maps each auto-approved tool call to its rule', () => {
  assert.deepEqual(autoApprovals([
    { type: 'auto-approved', toolCallId: 't1', rule: 'Bash(npm test:*)' },
    { type: 'assistant-text', text: 'x' },
    { type: 'auto-approved', toolCallId: 't2', rule: 'Edit(**)' },
  ]), { t1: 'Bash(npm test:*)', t2: 'Edit(**)' })
  assert.deepEqual(autoApprovals([]), {})
})

test('apply registers the settings section and the right-sidebar tab type', () => {
  const slots: { name: string; key?: string }[] = []
  const tabDefinitions: { id: string; kind: string; guide?: unknown[] }[] = []
  const effects: (() => void)[] = []
  const ctx = {
    get: (name: string) => (name === 'sidebarRightTabs' ? (ctx as { sidebarRightTabs?: unknown }).sidebarRightTabs : undefined),
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (options: { name: string; key?: string }) => {
        slots.push({ name: options.name, key: options.key })
        return () => undefined
      },
    },
    sidebarRightTabs: {
      register: (definition: { id: string; kind: string; guide?: unknown[] }) => {
        tabDefinitions.push(definition)
        return () => undefined
      },
    },
    effect: (callback: () => () => void) => {
      effects.push(callback())
    },
  }
  ;(client.apply as (ctx: unknown) => void)(ctx)
  assert.deepEqual(slots.map((entry) => entry.name), [
    'settings.section',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])
  assert.equal(slots[1]!.key, 'dsh-claude-workspace')
  assert.equal(tabDefinitions.length, 1)
  assert.equal(tabDefinitions[0]!.kind, 'claude-workspace')
  assert.ok(Array.isArray(tabDefinitions[0]!.guide) && tabDefinitions[0]!.guide.length > 0)
  assert.equal(effects.length, 2)
  assert.ok(effects.every((dispose) => typeof dispose === 'function'))
})

const scaledDimensions = client.scaledDimensions as (width: number, height: number, maxEdge?: number) => { width: number; height: number }
const base64Bytes = client.base64Bytes as (base64: string) => number

test('image scaling fits the long edge and keeps the aspect ratio', () => {
  assert.deepEqual(scaledDimensions(800, 600), { width: 800, height: 600 })
  assert.deepEqual(scaledDimensions(4096, 2048), { width: 2048, height: 1024 })
  assert.deepEqual(scaledDimensions(1000, 4000), { width: 512, height: 2048 })
  assert.deepEqual(scaledDimensions(1, 4096), { width: 1, height: 2048 })
  assert.deepEqual(scaledDimensions(4096, 4096, 512), { width: 512, height: 512 })
})

test('base64 byte length does not count framing characters', () => {
  assert.equal(base64Bytes(''), 0)
  assert.equal(base64Bytes('QQ=='), 1)
  assert.equal(base64Bytes('QUI='), 2)
  assert.equal(base64Bytes('QUJD'), 3)
  assert.equal(base64Bytes('QUJDRA=='), 4)
})

const collectToolCards = client.collectToolCards as (events: unknown[]) => {
  cards: Map<string, { toolCallId: string; title: string; status?: string; parentToolCallId?: string }>
  order: string[]
  childrenByParent: Map<string, { toolCallId: string }[]>
}

test('tool cards keep the latest state once and nest subagent children under their launch', () => {
  const events = [
    { type: 'tool-call', seq: 1, card: { toolCallId: 'agent', title: 'Task', status: 'pending' } },
    { type: 'tool-update', seq: 2, card: { toolCallId: 'agent', title: 'List files', status: 'running' } },
    { type: 'tool-call', seq: 3, card: { toolCallId: 'child', title: 'ls', status: 'pending', parentToolCallId: 'agent' } },
    { type: 'tool-update', seq: 4, card: { toolCallId: 'child', title: 'ls', status: 'ok', parentToolCallId: 'agent' } },
    { type: 'tool-call', seq: 5, card: { toolCallId: 'orphan', title: 'Read', parentToolCallId: 'missing' } },
    { type: 'assistant-text', seq: 6, text: 'done' },
  ]
  const tree = collectToolCards(events)
  assert.deepEqual(tree.order, ['agent', 'child', 'orphan'])
  assert.equal(tree.cards.get('agent')!.title, 'List files')
  assert.equal(tree.cards.get('child')!.status, 'ok')
  assert.deepEqual(tree.childrenByParent.get('agent')!.map((card) => card.toolCallId), ['child'])
  assert.equal(tree.childrenByParent.has('orphan'), false)
})

const parseMarkdown = client.parseMarkdown as (text: string) => Array<Record<string, unknown>>
const parseInline = client.parseInline as (text: string) => Array<Record<string, unknown>>
const splitTableRow = client.splitTableRow as (line: string) => string[]

test('Markdown blocks cover headings, fences, lists, tables, quotes, and paragraphs', () => {
  const blocks = parseMarkdown([
    '# Title',
    '',
    '| 名称 | 类型 |',
    '|------|------|',
    '| `.claude/` | 目录 |',
    '| `README.md` | 文件 |',
    '',
    '需要我查看某个文件的内容吗？',
    '',
    '- one',
    '- two',
    '',
    '```sh',
    'echo hi',
    '```',
    '',
    '> quoted',
    '',
    '---',
  ].join('\n'))
  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'table', 'paragraph', 'list', 'code', 'quote', 'hr',
  ])
  assert.deepEqual(blocks[1], {
    type: 'table',
    header: ['名称', '类型'],
    rows: [['`.claude/`', '目录'], ['`README.md`', '文件']],
  })
  assert.deepEqual(blocks[3], { type: 'list', ordered: false, items: [{ indent: 0, text: 'one' }, { indent: 0, text: 'two' }] })
  assert.equal(blocks[4]!.lang, 'sh')
  assert.equal(blocks[4]!.text, 'echo hi')
})

test('Markdown inline parsing handles code, emphasis, strike, and links', () => {
  const tokens = parseInline('use `pwd` **now** and *carefully* ~~maybe~~ [docs](https://example.com)')
  assert.deepEqual(tokens.map((token) => token.type), [
    'text', 'code', 'text', 'strong', 'text', 'em', 'text', 'strike', 'text', 'link',
  ])
  assert.deepEqual(tokens[1], { type: 'code', text: 'pwd' })
  assert.deepEqual(tokens[9], { type: 'link', text: 'docs', href: 'https://example.com' })
})

test('table rows split without the framing pipes', () => {
  assert.deepEqual(splitTableRow('| a | b |'), ['a', 'b'])
  assert.deepEqual(splitTableRow('a|b'), ['a', 'b'])
})

const needsResume = client.needsResume as (runtime: string, running: boolean, bound: boolean) => boolean

test('a persisted console binding offers resume after a Host restart', () => {
  assert.equal(needsResume('stopped', false, true), true)
  assert.equal(needsResume('disconnected', false, true), true)
  assert.equal(needsResume('stopped', false, false), false)
  assert.equal(needsResume('ready', false, true), false)
  assert.equal(needsResume('stopped', true, true), false)
})
