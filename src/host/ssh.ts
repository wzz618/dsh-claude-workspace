import type { ResolvedConfig } from '../config.ts'
import { CcwError, tail } from '../util/errors.ts'
import { LocalHost } from './local.ts'
import { parseVersion } from './probe.ts'
import { buildRemoteCommand } from './shell.ts'
import type { ExecOptions, ExecResult, HostOps, HostProcess, PathInfo, ProbeResult, SpawnOptions, AtomicFileOptions, DirectoryEntry } from './types.ts'
import { childPath, compareEntries } from './entries.ts'

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

  async listDirectory(path: string, limit = 500): Promise<DirectoryEntry[]> {
    const script = 'dir=$0; if [ ! -d "$dir" ]; then exit 4; fi; find -- "$dir" -mindepth 1 -maxdepth 1 -printf \'%y\\t%f\\0\''
    const result = await this.#execRemote(['sh', '-c', script, path])
    if (result.code === 4) throw new CcwError('dir-not-found', `${path} does not exist on ${this.#options.alias}`, { path })
    if (result.code !== 0) {
      throw new CcwError(
        'host-probe-failed',
        `could not list ${path} on ${this.#options.alias}: ${tail(result.stderr)}`,
        { path, host: this.id },
      )
    }
    const entries: DirectoryEntry[] = []
    for (const record of result.stdout.split('\0')) {
      if (record.length === 0) continue
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const type = record.slice(0, tab)
      const name = record.slice(tab + 1)
      if (name.length === 0) continue
      entries.push({ name, path: childPath(path, name), isDirectory: type === 'd' })
    }
    return entries.sort(compareEntries).slice(0, Math.max(0, limit))
  }

  async readText(path: string): Promise<string | undefined> {    const script = 'if [ ! -e "$0" ] && [ ! -L "$0" ]; then exit 3; fi; cat -- "$0"'
    const result = await this.#execRemote(['sh', '-c', script, path])
    if (result.code === 3) return undefined
    if (result.code !== 0) {
      throw new CcwError(
        'settings-invalid',
        `could not read ${path} on ${this.#options.alias}: ${tail(result.stderr)}`,
        { path, host: this.id },
      )
    }
    return result.stdout
  }

  async writeTextAtomic(path: string, content: string, options: AtomicFileOptions = {}): Promise<void> {
    const mode = (options.mode ?? 0o600).toString(8)
    const script = `set -e
target=$1
mode=$2
backup=$3
dir=$(dirname -- "$target")
mkdir -p -- "$dir"
tmp=$(mktemp "$dir/.ccw-settings.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
chmod "$mode" "$tmp"
if [ "$backup" = "1" ] && [ -e "$target" ]; then cp -p -- "$target" "$target.bak"; fi
mv -f -- "$tmp" "$target"
trap - EXIT`
    const child = await this.#transport.spawn(this.remoteArgv([
      'sh', '-c', script, 'ccw-write', path, mode, options.backup === true ? '1' : '0',
    ]))
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = tail(stderr + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk), 4000)
    })
    try {
      child.stdin.write(content)
      child.stdin.end()
    } catch (error) {
      child.kill('SIGKILL')
      throw new CcwError(
        'settings-write-failed',
        `could not send settings to ${path} on ${this.#options.alias}: ${messageOf(error)}`,
        { path, host: this.id },
        { cause: error },
      )
    }
    const exit = await child.exited
    if (exit.code !== 0) {
      throw new CcwError(
        'settings-write-failed',
        `could not write ${path} on ${this.#options.alias}: ${tail(stderr) || `remote writer exited ${exit.code}`}`,
        { path, host: this.id },
      )
    }
  }

  async removeFile(path: string): Promise<void> {
    const result = await this.#execRemote(['rm', '-f', '--', path])
    if (result.code !== 0) {
      throw new CcwError(
        'settings-write-failed',
        `could not remove ${path} on ${this.#options.alias}: ${tail(result.stderr)}`,
        { path, host: this.id },
      )
    }
  }

  async home(): Promise<string> {
    const result = await this.#execRemote(['sh', '-c', 'printf %s "${HOME:-}"'])
    const home = result.stdout.trim()
    if (result.code !== 0 || home.length === 0) {
      throw new CcwError(
        'host-probe-failed',
        `could not determine the home directory of ${this.#options.alias}`,
        { host: this.id },
      )
    }
    return home
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
