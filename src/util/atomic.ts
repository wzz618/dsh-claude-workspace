import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CcwError } from './errors.ts'

/** Options controlling a durable file replacement. */
export interface AtomicWriteOptions {
  /** Copies the previous file to `<path>.bak` before replacing it. */
  readonly backup?: boolean
  /** File mode for the new file, for example 0o600 for settings. */
  readonly mode?: number
}

/**
 * Replaces `path` with `content` through a same-directory temporary file:
 * write, fsync, optional `.bak`, rename, then a directory fsync. A reader sees
 * either the previous bytes or the complete new bytes, never a partial file.
 *
 * @param path - Absolute destination path.
 * @param content - Complete new file content.
 * @param options - Backup and permission options.
 * @throws {CcwError} With `settings-write-failed` when the replacement fails.
 */
export async function atomicWriteFile(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await ensureParent(path)
    const handle = await open(temporary, 'w', options.mode ?? 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options.backup === true) {
      try {
        await copyFile(path, `${path}.bak`)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new CcwError('settings-write-failed', `could not write ${path}: ${messageOf(error)}`, { path }, { cause: error })
  }
}

/**
 * Serializes `value` as JSON and replaces `path` atomically.
 *
 * @param path - Absolute destination path.
 * @param value - JSON-serializable value.
 * @param options - Backup and permission options.
 */
export async function atomicWriteJson(path: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, options)
}

/** Reads a JSON file, returning `fallback` when it does not exist. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return fallback
    throw new CcwError('state-invalid', `could not read ${path}: ${messageOf(error)}`, { path }, { cause: error })
  }
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new CcwError('state-invalid', `${path} is not valid JSON`, { path }, { cause: error })
  }
}

/** Reads a text file, returning `undefined` when it does not exist. */
export async function readTextFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some filesystems; the rename itself
    // still guarantees readers see a complete file.
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
