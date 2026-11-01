import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SerialQueue } from './queue.ts'

export interface RollingLogOptions {
  /** Size at which the current file is rotated. */
  readonly maxBytes: number
  /** Total files kept, including the active one. */
  readonly files: number
}

/**
 * Append-only log with size-based rotation.
 *
 * The active file is `<path>`; rotated files are `<path>.1` … `<path>.<files-1>`
 * with `.1` newest. Writes are serialized per path so rotation cannot race an
 * append; a failed write rejects to the caller, which treats diagnostics as
 * best-effort.
 */
export class RollingLogSink {
  readonly #path: string
  readonly #options: RollingLogOptions
  readonly #queue = new SerialQueue()
  #size: number | undefined

  constructor(path: string, options: RollingLogOptions) {
    this.#path = path
    this.#options = options
  }

  /**
   * Appends one chunk, rotating first when it would exceed the limit.
   *
   * @param text - UTF-8 text chunk.
   */
  async append(text: string): Promise<void> {
    if (text.length === 0) return
    const bytes = Buffer.byteLength(text, 'utf8')
    await this.#queue.run(this.#path, async () => {
      await this.#ensure()
      if ((this.#size ?? 0) > 0 && (this.#size ?? 0) + bytes > this.#options.maxBytes) {
        await this.#rotate()
      }
      await appendFile(this.#path, text, 'utf8')
      this.#size = (this.#size ?? 0) + bytes
    })
  }

  async #ensure(): Promise<void> {
    if (this.#size !== undefined) return
    await mkdir(dirname(this.#path), { recursive: true })
    try {
      this.#size = (await stat(this.#path)).size
    } catch {
      this.#size = 0
    }
  }

  async #rotate(): Promise<void> {
    const files = Math.max(1, this.#options.files)
    if (files === 1) {
      await rm(this.#path, { force: true })
      this.#size = 0
      return
    }
    await rm(`${this.#path}.${files - 1}`, { force: true })
    for (let index = files - 2; index >= 1; index -= 1) {
      await rename(`${this.#path}.${index}`, `${this.#path}.${index + 1}`).catch(() => undefined)
    }
    await rename(this.#path, `${this.#path}.1`).catch(() => undefined)
    this.#size = 0
  }
}
