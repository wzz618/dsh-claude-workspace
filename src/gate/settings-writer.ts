import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson, readJsonFile, readTextFileOrUndefined } from '../util/atomic.ts'
import { CcwError } from '../util/errors.ts'
import { SerialQueue } from '../util/queue.ts'

/** Rule written by CCW, tracked for individual revocation. */
export interface WrittenRule {
  readonly id: string
  /** ISO-8601 creation instant. */
  readonly ts: string
  /** Settings file the rule was appended to. */
  readonly file: string
  readonly rule: string
  readonly tool?: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly requestId?: string
}

interface WrittenRulesFile {
  readonly version: 1
  readonly rules: WrittenRule[]
}

/** Metadata attached to one append. */
export interface RuleMetadata {
  readonly tool?: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly requestId?: string
}

/** Result of ensuring rules exist in a settings file. */
export interface EnsureAllowedResult {
  readonly changed: boolean
  readonly file: string
  readonly added: readonly string[]
  readonly existing: readonly string[]
}

/**
 * Appends CCW-generated allow rules to a Claude settings file.
 *
 * The writer is deliberately strict: a missing file is initialized, but an
 * existing file that does not parse as JSON, whose root is not an object, or
 * whose `permissions.allow` is not a string array is left untouched and
 * reported. Silently rewriting such a file would destroy user configuration.
 * Every replacement is atomic with a `.bak` copy and a read-back check.
 */
export class SettingsWriter {
  readonly #dataDir: string
  readonly #queue = new SerialQueue()
  readonly #now: () => Date

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#dataDir = dataDir
    this.#now = now
  }

  /**
   * Ensures every rule is present in `file`.
   *
   * @param file - Absolute settings path.
   * @param rules - Rule texts to append; duplicates are skipped.
   * @param metadata - Trace metadata stored in the revocation sidecar.
   * @returns Which rules were added.
   * @throws {CcwError} With `settings-invalid` or `settings-write-failed`.
   */
  async ensureAllowed(file: string, rules: readonly string[], metadata: RuleMetadata = {}): Promise<EnsureAllowedResult> {
    return this.#queue.run(file, async () => {
      const previousText = await readTextFileOrUndefined(file)
      const document = parseSettings(previousText, file)
      const permissions = ensurePermissions(document, file)
      const allow = ensureAllowArray(permissions, file)
      const existing = new Set(allow)
      const added: string[] = []
      for (const rule of rules) {
        if (existing.has(rule)) continue
        allow.push(rule)
        existing.add(rule)
        added.push(rule)
      }
      if (added.length === 0) return { changed: false, file, added: [], existing: rules }
      const mode = await modeOf(file)
      await atomicWriteFile(file, `${JSON.stringify(document, null, 2)}\n`, { backup: true, mode })
      const verified = await verifyFile(file, rules)
      if (!verified) {
        await restore(file, previousText, mode)
        throw new CcwError('settings-write-failed', `wrote ${file} but could not read the rules back; original restored`, { file })
      }
      await this.#record({ file, rules: added, metadata })
      return { changed: true, file, added, existing: rules.filter((rule) => !added.includes(rule)) }
    })
  }

  /** Rules CCW wrote, newest last. */
  async listWrittenRules(): Promise<WrittenRule[]> {
    return (await this.#readSidecar()).rules
  }

  /**
   * Removes one CCW-written rule from its settings file and the sidecar.
   *
   * @param id - Sidecar rule id.
   * @returns The removed record.
   * @throws {CcwError} When the id is unknown or the settings file is now invalid.
   */
  async revoke(id: string): Promise<WrittenRule> {
    const sidecar = await this.#readSidecar()
    const entry = sidecar.rules.find((rule) => rule.id === id)
    if (entry === undefined) {
      throw new CcwError('settings-invalid', `no CCW-written rule with id ${id}`, { id })
    }
    await this.#queue.run(entry.file, async () => {
      const previousText = await readTextFileOrUndefined(entry.file)
      const document = parseSettings(previousText, entry.file)
      const permissions = ensurePermissions(document, entry.file)
      const allow = ensureAllowArray(permissions, entry.file)
      const remaining = allow.filter((rule) => rule !== entry.rule)
      if (remaining.length === allow.length) return
      permissions.allow = remaining
      const mode = await modeOf(entry.file)
      await atomicWriteFile(entry.file, `${JSON.stringify(document, null, 2)}\n`, { backup: true, mode })
      const verified = await verifyFileAbsent(entry.file, entry.rule)
      if (!verified) {
        await restore(entry.file, previousText, mode)
        throw new CcwError('settings-write-failed', `could not verify removal from ${entry.file}; original restored`, {
          file: entry.file,
          rule: entry.rule,
        })
      }
    })
    await this.#writeSidecar({ version: 1, rules: sidecar.rules.filter((rule) => rule.id !== id) })
    return entry
  }

  async #record(input: { file: string; rules: readonly string[]; metadata: RuleMetadata }): Promise<void> {
    const sidecar = await this.#readSidecar()
    const ts = this.#now().toISOString()
    const added: WrittenRule[] = input.rules.map((rule) => ({
      id: `rule_${randomUUID().slice(0, 8)}`,
      ts,
      file: input.file,
      rule,
      ...(input.metadata.tool === undefined ? {} : { tool: input.metadata.tool }),
      ...(input.metadata.workspaceId === undefined ? {} : { workspaceId: input.metadata.workspaceId }),
      ...(input.metadata.sessionId === undefined ? {} : { sessionId: input.metadata.sessionId }),
      ...(input.metadata.requestId === undefined ? {} : { requestId: input.metadata.requestId }),
    }))
    await this.#writeSidecar({ version: 1, rules: [...sidecar.rules, ...added] })
  }

  async #readSidecar(): Promise<WrittenRulesFile> {
    const file = await readJsonFile<WrittenRulesFile>(join(this.#dataDir, 'written-rules.json'), { version: 1, rules: [] })
    if (file.version !== 1 || !Array.isArray(file.rules)) {
      throw new CcwError('settings-invalid', 'written-rules.json has an unsupported format', {})
    }
    return file
  }

  async #writeSidecar(file: WrittenRulesFile): Promise<void> {
    await atomicWriteJson(join(this.#dataDir, 'written-rules.json'), file)
  }
}

/**
 * Resolves the settings file a rule is written to.
 *
 * @param workspaceDir - Session working directory.
 * @param target - `project` for `.claude/settings.local.json`, `user` for `~/.claude/settings.json`.
 * @param home - Home directory on the host that owns the file.
 * @returns Absolute settings path.
 */
export function settingsTargetPath(workspaceDir: string, target: 'project' | 'user', home: string): string {
  return target === 'project'
    ? join(workspaceDir, '.claude', 'settings.local.json')
    : join(home, '.claude', 'settings.json')
}

type SettingsDocument = Record<string, unknown> & { permissions?: Record<string, unknown> & { allow?: string[] } }

function parseSettings(text: string | undefined, file: string): SettingsDocument {
  if (text === undefined) return { permissions: { allow: [] } }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CcwError('settings-invalid', `${file} is not valid JSON (including JSONC comments); refusing to rewrite it`, { file })
  }
  if (!isRecord(parsed)) {
    throw new CcwError('settings-invalid', `${file} must contain a JSON object; refusing to rewrite it`, { file })
  }
  return parsed as SettingsDocument
}

function ensurePermissions(document: SettingsDocument, file: string): Record<string, unknown> & { allow?: string[] } {
  const permissions = document.permissions
  if (permissions === undefined) {
    const created: Record<string, unknown> & { allow: string[] } = { allow: [] }
    document.permissions = created
    return created
  }
  if (!isRecord(permissions)) {
    throw new CcwError('settings-invalid', `${file}: "permissions" must be an object; refusing to rewrite it`, { file })
  }
  return permissions as Record<string, unknown> & { allow?: string[] }
}

function ensureAllowArray(permissions: Record<string, unknown> & { allow?: string[] }, file: string): string[] {
  const allow = permissions.allow
  if (allow === undefined) {
    const created: string[] = []
    permissions.allow = created
    return created
  }
  if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === 'string')) {
    throw new CcwError('settings-invalid', `${file}: "permissions.allow" must be an array of strings; refusing to rewrite it`, {
      file,
    })
  }
  return allow
}

async function verifyFile(file: string, rules: readonly string[]): Promise<boolean> {
  const text = await readTextFileOrUndefined(file)
  if (text === undefined) return false
  try {
    const document = JSON.parse(text) as unknown
    if (!isRecord(document) || !isRecord(document.permissions)) return false
    const allow = document.permissions.allow
    return Array.isArray(allow) && rules.every((rule) => allow.includes(rule))
  } catch {
    return false
  }
}

async function verifyFileAbsent(file: string, rule: string): Promise<boolean> {
  const text = await readTextFileOrUndefined(file)
  if (text === undefined) return true
  try {
    const document = JSON.parse(text) as unknown
    if (!isRecord(document) || !isRecord(document.permissions)) return false
    const allow = document.permissions.allow
    return Array.isArray(allow) && !allow.includes(rule)
  } catch {
    return false
  }
}

async function restore(file: string, previousText: string | undefined, mode: number): Promise<void> {
  if (previousText === undefined) {
    await rm(file, { force: true })
    return
  }
  await atomicWriteFile(file, previousText, { mode })
}

async function modeOf(file: string): Promise<number> {
  try {
    const info = await stat(file)
    return info.mode & 0o777
  } catch {
    return 0o600
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
