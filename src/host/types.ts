/** Existence and type of a path on a host. */
export interface PathInfo {
  readonly exists: boolean
  readonly isDirectory: boolean
}

/** Result of asking a host whether the ACP executable is usable. */
export interface ProbeResult {
  readonly found: boolean
  /** Absolute path reported by `command -v`, when found. */
  readonly path?: string
  /** Version reported by `--version`, when the executable prints one. */
  readonly version?: string
  /** Tail of stderr from the version probe. */
  readonly stderr?: string
}

/** Completed command result. */
export interface ExecResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly maxOutputBytes?: number
}

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

/** Durable replacement options for one host file. */
export interface AtomicFileOptions {
  /** Copies the previous file to `<path>.bak` before replacing it. */
  readonly backup?: boolean
  /** Permission bits for the new file, for example 0o600. */
  readonly mode?: number
}

/** A started child process with stream access and one exit promise. */
export interface HostProcess {
  readonly pid: number | undefined
  readonly stdin: NodeJS.WritableStream
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  kill(signal?: NodeJS.Signals): void
}

/**
 * The operations the workspace and runtime layers need from a host.
 *
 * Local and SSH hosts differ only here; everything above this interface is
 * shared. Every method takes and returns plain values so a host can be
 * replaced by a test double.
 */
export interface HostOps {
  readonly id: string
  readonly kind: 'local' | 'ssh'
  stat(path: string): Promise<PathInfo>
  mkdirp(path: string): Promise<void>
  realpath(path: string): Promise<string>
  /** Reads a text file, or undefined when it does not exist. */
  readText(path: string): Promise<string | undefined>
  /** Replaces a file through a same-directory temporary file and rename. */
  writeTextAtomic(path: string, content: string, options?: AtomicFileOptions): Promise<void>
  /** Removes a file if present. */
  removeFile(path: string): Promise<void>
  /** The host account's home directory. */
  home(): Promise<string>
  probe(executable: string, args?: readonly string[]): Promise<ProbeResult>
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>
  spawn(argv: readonly string[], options?: SpawnOptions): Promise<HostProcess>
  /** Starts the long-lived ACP process with the host's configured executable. */
  spawnAcp(cwd?: string): Promise<HostProcess>
}
