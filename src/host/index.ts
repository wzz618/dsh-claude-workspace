import type { HostConfig, ResolvedConfig } from '../config.ts'
import { LocalHost } from './local.ts'
import { SshHost } from './ssh.ts'
import type { HostOps } from './types.ts'

/** Creates the `HostOps` implementation for one resolved host entry. */
export function createHostOps(id: string, host: HostConfig, ssh: ResolvedConfig['ssh']): HostOps {
  switch (host.kind) {
    case 'local':
      return new LocalHost(id, host.env, host.executable, host.args)
    case 'ssh':
      return new SshHost({
        id,
        alias: host.alias ?? id,
        executable: host.executable,
        args: host.args,
        ...(host.command === undefined ? {} : { command: host.command }),
        env: host.env,
        ssh,
        connectTimeoutMs: host.connectTimeoutMs,
      })
  }
}

export { LocalHost } from './local.ts'
export { SshHost, buildSshArgv } from './ssh.ts'
export { buildRemoteCommand, quotePosix } from './shell.ts'
export type {
  ExecOptions,
  ExecResult,
  HostOps,
  HostProcess,
  PathInfo,
  ProbeResult,
  SpawnOptions,
} from './types.ts'
