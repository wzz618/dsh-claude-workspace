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
