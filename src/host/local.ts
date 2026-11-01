import { spawn as spawnChild } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { scrubEnvironment } from '../util/env.ts'
import { CcwError, tail } from '../util/errors.ts'
import type { ExecOptions, ExecResult, HostOps, HostProcess, PathInfo, ProbeResult, SpawnOptions } from './types.ts'
import { parseVersion } from './probe.ts'

/** Executes Claude Code on the DSH host itself. */
export class LocalHost implements HostOps {
  readonly kind = 'local'
  readonly id: string
  readonly #env: Readonly<Record<string, string>>
  readonly #executable: string
  readonly #args: readonly string[]

  constructor(
    id: string,
    env: Readonly<Record<string, string>> = {},
    executable = 'claude-agent-acp',
    args: readonly string[] = [],
  ) {
    this.id = id
    this.#env = env
    this.#executable = executable
    this.#args = args
  }

  async stat(path: string): Promise<PathInfo> {
    try {
      const info = await stat(path)
      return { exists: true, isDirectory: info.isDirectory() }
    } catch (error) {
      if (isMissing(error)) return { exists: false, isDirectory: false }
      throw error
    }
  }

  async mkdirp(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true })
    } catch (error) {
      throw new CcwError('dir-create-failed', `could not create ${path}: ${messageOf(error)}`, { path }, { cause: error })
    }
  }

  async realpath(path: string): Promise<string> {
    return realpath(path)
  }

  async probe(executable: string, args: readonly string[] = []): Promise<ProbeResult> {
    const lookup = await this.exec(['sh', '-c', 'command -v "$0"', executable], { timeoutMs: 10_000 })
    const path = lookup.stdout.trim().split('\n')[0] ?? ''
    if (lookup.code !== 0 || path.length === 0) {
      return { found: false, stderr: tail(lookup.stderr) }
    }
    const version = await this.exec([path, ...args, '--version'], { timeoutMs: 10_000 })
    const parsed = parseVersion(version.stdout)
    return {
      found: true,
      path,
      ...(parsed === undefined ? {} : { version: parsed }),
      ...(version.stderr.length === 0 ? {} : { stderr: tail(version.stderr) }),
    }
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const child = await this.spawn(argv)
    const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] }
    let bytes = 0
    const limit = options.maxOutputBytes ?? 1024 * 1024
    const collect = (target: string[], chunk: Buffer): void => {
      bytes += chunk.byteLength
      if (bytes <= limit) target.push(chunk.toString('utf8'))
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunks.stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(chunks.stderr, chunk))
    const timer = options.timeoutMs === undefined || options.timeoutMs === 0
      ? undefined
      : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    const abort = (): void => child.kill('SIGKILL')
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const exit = await child.exited
      return { code: exit.code, signal: exit.signal, stdout: chunks.stdout.join(''), stderr: chunks.stderr.join('') }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  async spawnAcp(cwd?: string): Promise<HostProcess> {
    return this.spawn([this.#executable, ...this.#args], cwd === undefined ? {} : { cwd })
  }

  async spawn(argv: readonly string[], options: SpawnOptions = {}): Promise<HostProcess> {
    const executable = argv[0]
    if (executable === undefined) throw new CcwError('acp-start-failed', 'cannot spawn an empty command')
    const child = spawnChild(executable, argv.slice(1), {
      cwd: options.cwd,
      env: scrubEnvironment(process.env, { ...this.#env, ...options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', (error) => {
        reject(new CcwError('acp-start-failed', `could not start ${executable}: ${error.message}`, { executable }, { cause: error }))
      })
      // `close` rather than `exit`: stdio has flushed by then, so exec callers
      // see every byte the child wrote.
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    // The start handshake below observes the same rejection; this handler keeps
    // the returned promise from reporting an unhandled rejection if a caller
    // never awaits it after a failed start.
    void exited.catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => {
        reject(new CcwError('acp-start-failed', `could not start ${executable}: ${error.message}`, { executable }, { cause: error }))
      })
    })
    return {
      pid: child.pid,
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      exited,
      kill: (signal?: NodeJS.Signals) => {
        child.kill(signal)
      },
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
