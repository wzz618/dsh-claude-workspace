import type { HostOps, HostProcess } from '../host/types.ts'
import { tail } from '../util/errors.ts'

export interface AcpProcessOptions {
  /** Bytes of stderr retained for diagnostics. */
  readonly stderrLimitBytes?: number
  /** Process working directory; local hosts use it to find project settings. */
  readonly cwd?: string
}

/**
 * One started `claude-agent-acp` process.
 *
 * stderr is retained only as a bounded tail: remote diagnostics can contain
 * paths and fragments of credentials, so the runtime keeps just enough to
 * explain a start failure and never forwards raw stderr to the model.
 */
export class AcpProcess {
  readonly #process: HostProcess
  readonly #stderrLimit: number
  #stderr = Buffer.alloc(0)
  #stopping = false

  constructor(process: HostProcess, options: AcpProcessOptions = {}) {
    this.#process = process
    this.#stderrLimit = options.stderrLimitBytes ?? 8192
    process.stderr.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const combined = Buffer.concat([this.#stderr, bytes])
      this.#stderr = combined.byteLength > this.#stderrLimit
        ? combined.subarray(combined.byteLength - this.#stderrLimit)
        : combined
    })
  }

  get pid(): number | undefined {
    return this.#process.pid
  }

  get stdin(): NodeJS.WritableStream {
    return this.#process.stdin
  }

  get stdout(): NodeJS.ReadableStream {
    return this.#process.stdout
  }

  get exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#process.exited
  }

  /** Bounded stderr tail, safe to show in an error report. */
  stderrTail(limit = 2000): string {
    return tail(this.#stderr.toString('utf8'), limit)
  }

  /** Asks the process to exit, then kills it after `graceMs`. */
  async stop(graceMs = 2000): Promise<void> {
    if (this.#stopping) {
      await this.#process.exited.catch(() => undefined)
      return
    }
    this.#stopping = true
    try {
      this.#process.stdin.end()
    } catch {
      // The pipe may already be closed; the exit wait below is authoritative.
    }
    this.#process.kill('SIGTERM')
    const exited = await Promise.race([
      this.#process.exited.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), graceMs)
        timer.unref?.()
      }),
    ])
    if (!exited) {
      this.#process.kill('SIGKILL')
      await this.#process.exited.catch(() => undefined)
    }
  }
}

/**
 * Spawns the ACP process on a host.
 *
 * @param host - Local or SSH host implementation.
 * @param options - stderr retention bound.
 * @returns The process handle whose stdio becomes the ACP transport.
 */
export async function startAcpProcess(host: HostOps, options: AcpProcessOptions = {}): Promise<AcpProcess> {
  const child = await host.spawnAcp(options.cwd)
  return new AcpProcess(child, options)
}
