import type { ResolvedConfig } from '../config.ts'
import { CcwError, tail } from '../util/errors.ts'
import { LocalHost } from './local.ts'
import { parseVersion } from './probe.ts'
import { buildRemoteCommand } from './shell.ts'
import type { ExecOptions, ExecResult, HostOps, HostProcess, PathInfo, ProbeResult, SpawnOptions } from './types.ts'

/** Options that shape one SSH host invocation. */
export interface SshHostOptions {
  readonly id: string
  /** `~/.ssh/config` alias. */
  readonly alias: string
  readonly executable: string
  readonly args: readonly string[]
  readonly command?: string
  readonly env: Readonly<Record<string, string>>
  readonly ssh: ResolvedConfig['ssh']
  readonly connectTimeoutMs: number
}

/**
 * Runs Claude Code on a remote Linux host over `ssh -T`.
 *
 * The ACP stream is carried directly by SSH stdio: no bridge, no exposed port,
 * and no DSH installation is needed on the remote machine. Each workspace owns
 * its own connection; connection multiplexing is deliberately not enabled
 * because a shared master would take every workspace down with it.
 */
export class SshHost implements HostOps {
  readonly kind = 'ssh'
  readonly id: string
  readonly #options: SshHostOptions
  readonly #transport: LocalHost

  constructor(options: SshHostOptions) {
    assertAlias(options.alias)
    this.id = options.id
    this.#options = options
    this.#transport = new LocalHost(`${options.id}:ssh`, options.env)
  }

  /** The argv that starts the ACP process on the remote host. */
  acpArgv(): string[] {
    const remote = this.#options.command ?? buildRemoteCommand([this.#options.executable, ...this.#options.args])
    return buildSshArgv(this.#options, remote)
  }

  /** The argv for a short remote command, used by probe and workspace setup. */
  remoteArgv(argv: readonly string[]): string[] {
    return buildSshArgv(this.#options, buildRemoteCommand(argv))
  }

  async stat(path: string): Promise<PathInfo> {
    const script = 'if [ -d "$0" ]; then printf dir; elif [ -e "$0" ] || [ -L "$0" ]; then printf file; else printf missing; fi'
    const result = await this.#execRemote(['sh', '-c', script, path])
    const value = result.stdout.trim()
    return { exists: value === 'dir' || value === 'file', isDirectory: value === 'dir' }
  }

  async mkdirp(path: string): Promise<void> {
    const result = await this.#execRemote(['mkdir', '-p', '--', path])
    if (result.code !== 0) {
      throw new CcwError(
        'dir-create-failed',
        `could not create ${path} on ${this.#options.alias}: ${tail(result.stderr) || `mkdir exited ${result.code}`}`,
        { path, host: this.id },
      )
    }
  }

  async realpath(path: string): Promise<string> {
    const result = await this.#execRemote(['readlink', '-f', '--', path])
    if (result.code !== 0 || result.stdout.trim().length === 0) {
      throw new CcwError('dir-not-found', `could not resolve ${path} on ${this.#options.alias}`, {
        path,
        host: this.id,
        stderr: tail(result.stderr),
      })
    }
    return result.stdout.trim()
  }

  async probe(executable: string, args: readonly string[] = []): Promise<ProbeResult> {
    const lookup = await this.#execRemote(['sh', '-c', 'command -v "$0"', executable])
    const path = lookup.stdout.trim().split('\n')[0] ?? ''
    if (lookup.code !== 0 || path.length === 0) {
      return { found: false, stderr: tail(lookup.stderr) }
    }
    const version = await this.#execRemote([executable, ...args, '--version'])
    const parsed = parseVersion(version.stdout)
    return {
      found: true,
      path,
      ...(parsed === undefined ? {} : { version: parsed }),
      ...(version.stderr.length === 0 ? {} : { stderr: tail(version.stderr) }),
    }
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.#transport.exec(this.remoteArgv(argv), options)
  }

  async spawn(argv: readonly string[], options: SpawnOptions = {}): Promise<HostProcess> {
    return this.#transport.spawn(this.remoteArgv(argv), options)
  }

  /**
   * Starts the long-lived ACP process.
   *
   * `cwd` is intentionally ignored (B7): the remote command is the configured
   * executable or `command`, and the session's directory comes from
   * `session/new`. A deployment that must start elsewhere uses `command`.
   */
  async spawnAcp(): Promise<HostProcess> {
    return this.#transport.spawn(this.acpArgv())
  }

  async #execRemote(argv: readonly string[]): Promise<ExecResult> {
    const result = await this.#transport.exec(this.remoteArgv(argv), {
      timeoutMs: this.#options.connectTimeoutMs + 10_000,
    })
    if (result.code === 255) {
      throw new CcwError(
        'host-unreachable',
        `SSH host "${this.#options.alias}" is unreachable: ${tail(result.stderr) || 'ssh exited 255'}. ` +
          `Check that \`ssh ${this.#options.alias}\` works without an interactive password prompt.`,
        { host: this.id, alias: this.#options.alias },
      )
    }
    return result
  }
}

/**
 * Builds the full SSH argv for one remote command.
 *
 * `BatchMode=yes` fails instead of prompting, `-T` disables a TTY so the ACP
 * stream stays a clean pipe, and keepalive options bound how long a dead
 * connection is detected.
 *
 * @param options - Host and keepalive settings.
 * @param remoteCommand - Already-quoted remote command string.
 * @returns The argv for `node:child_process.spawn`.
 */
export function buildSshArgv(options: Pick<SshHostOptions, 'alias' | 'ssh' | 'connectTimeoutMs'>, remoteCommand: string): string[] {
  const connectSeconds = Math.max(1, Math.ceil(options.connectTimeoutMs / 1000))
  return [
    'ssh',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    `StrictHostKeyChecking=${options.ssh.strictHostKeyChecking ? 'yes' : 'no'}`,
    '-o',
    `ConnectTimeout=${connectSeconds}`,
    '-o',
    `ServerAliveInterval=${options.ssh.serverAliveIntervalSec}`,
    '-o',
    `ServerAliveCountMax=${options.ssh.serverAliveCountMax}`,
    '--',
    options.alias,
    remoteCommand,
  ]
}

/** Rejects aliases that cannot be passed as one SSH destination argument. */
function assertAlias(alias: string): void {
  if (alias.length === 0 || /[\s\x00-\x1f]/.test(alias)) {
    throw new CcwError('config-invalid', `SSH alias "${alias}" must be a single non-empty word`, { alias })
  }
}
