import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CcwError } from './util/errors.ts'
import { SerialQueue } from './util/queue.ts'

/** What a decision concerned. */
export type AuditKind = 'permission' | 'widen' | 'plan' | 'session' | 'workspace'

/**
 * One audit line. Only metadata is recorded: no command text, no file
 * content, and no model output.
 */
export interface AuditEntry {
  readonly ts?: string
  readonly host: string
  readonly workspace: string
  readonly session: string
  readonly kind: AuditKind
  readonly tool?: string
  /** First 8 hex characters of the tool-argument digest. */
  readonly argsHash?: string
  readonly decision: string
  readonly latencyMs?: number
}

export interface AuditLogOptions {
  readonly retainDays: number
  readonly now?: () => Date
}

/**
 * Append-only daily JSONL audit under `<dir>/YYYY-MM-DD.jsonl`.
 *
 * The audit explains permission decisions without retaining sensitive
 * content; `hashArgs` allows correlating repeated calls without storing their
 * arguments.
 */
export class AuditLog {
  readonly #dir: string
  readonly #retainDays: number
  readonly #now: () => Date
  readonly #queue = new SerialQueue()

  constructor(dir: string, options: AuditLogOptions) {
    this.#dir = dir
    this.#retainDays = options.retainDays
    this.#now = options.now ?? (() => new Date())
  }

  /** Appends one entry to today's file. */
  async append(entry: AuditEntry): Promise<void> {
    const ts = entry.ts ?? this.#now().toISOString()
    const day = ts.slice(0, 10)
    const file = join(this.#dir, `${day}.jsonl`)
    const line = `${JSON.stringify({ ...entry, ts })}\n`
    await this.#queue.run(file, async () => {
      try {
        await mkdir(this.#dir, { recursive: true })
        await appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        throw new CcwError('audit-write-failed', `could not append ${file}: ${messageOf(error)}`, { file }, { cause: error })
      }
    })
  }

  /** Reads one day's entries, oldest first. */
  async list(day: string): Promise<AuditEntry[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new CcwError('state-invalid', `audit day must be YYYY-MM-DD, got "${day}"`, { day })
    }
    const file = join(this.#dir, `${day}.jsonl`)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw new CcwError('state-invalid', `could not read ${file}: ${messageOf(error)}`, { file }, { cause: error })
    }
    const entries: AuditEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        entries.push(JSON.parse(line) as AuditEntry)
      } catch {
        // A partially written trailing line from a crash is skipped rather
        // than failing the whole read.
      }
    }
    return entries
  }

  /** Deletes files older than the retention window. */
  async prune(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const cutoff = this.#now().getTime() - this.#retainDays * 86_400_000
    const removed: string[] = []
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (match === null) continue
      if (new Date(`${match[1]}T00:00:00Z`).getTime() >= cutoff) continue
      await rm(join(this.#dir, name), { force: true })
      removed.push(name)
    }
    return removed
  }
}

/**
 * Digests tool arguments for correlation without retaining them.
 *
 * @param rawInput - Tool arguments from the permission request.
 * @returns Eight hex characters, or undefined when no arguments were reported.
 */
export function hashArgs(rawInput: unknown): string | undefined {
  if (rawInput === undefined) return undefined
  try {
    return createHash('sha256').update(JSON.stringify(rawInput), 'utf8').digest('hex').slice(0, 8)
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
