import type { ResolvedConfig } from '../config.ts'

/**
 * Provider routing for native Claude sessions.
 *
 * The ACP adapter addresses agents by id (`acp-<id>`). The local host keeps the
 * configured `native.provider` unchanged; each SSH host gets its own id so its
 * launcher (ssh + remote binary) can be described independently in the
 * adapter's `agents.json`.
 *
 * @param config - Resolved plugin configuration.
 * @returns the provider route for the local host.
 */
export function localNativeProvider(config: ResolvedConfig): string {
  return config.native.provider
}

/** The agent id part of the local provider route. */
function localAgentId(config: ResolvedConfig): string {
  return config.native.provider.startsWith('acp-')
    ? config.native.provider.slice('acp-'.length)
    : config.native.provider
}

/**
 * Provider route for one workspace host.
 *
 * Local hosts share {@link localNativeProvider}; SSH host ids are sanitized to
 * the adapter's `^[a-z][a-z0-9-]*$` agent id grammar, with deterministic
 * suffixes when two configured ids collapse to the same form.
 *
 * @param config - Resolved plugin configuration.
 * @param hostId - Key in `config.hosts`.
 * @returns the adapter provider route for that host.
 */
export function nativeProviderForHost(config: ResolvedConfig, hostId: string): string {
  const host = config.hosts[hostId]
  if (host === undefined || host.kind === 'local') return localNativeProvider(config)
  const base = localAgentId(config).replace(/^[^a-z]+/, '') || 'claude'
  return `acp-${base}-${sshAgentSuffix(config, hostId)}`
}

/** The agent id used for one host, without the `acp-` prefix. */
export function nativeAgentIdForHost(config: ResolvedConfig, hostId: string): string {
  return nativeProviderForHost(config, hostId).slice('acp-'.length)
}

/** Deterministically map one SSH host id to the adapter's agent id suffix. */
function sshAgentSuffix(config: ResolvedConfig, hostId: string): string {
  const sshIds = Object.keys(config.hosts)
    .filter((id) => config.hosts[id]?.kind === 'ssh')
    .sort()
  const used = new Set<string>()
  for (const id of sshIds) {
    const base = sanitizeAgentId(id)
    let candidate = base
    let counter = 2
    while (used.has(candidate)) candidate = `${base}-${counter++}`
    used.add(candidate)
    if (id === hostId) return candidate
  }
  return sanitizeAgentId(hostId)
}

/**
 * Reduce an arbitrary host key to the adapter's agent id grammar.
 *
 * @param value - Configured host id.
 * @returns a lowercase id starting with a letter.
 */
export function sanitizeAgentId(value: string): string {
  const collapsed = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const withStart = /^[a-z]/.test(collapsed) ? collapsed : `h-${collapsed}`
  return withLeadingFix(withStart)
}

function withLeadingFix(value: string): string {
  return /^[a-z][a-z0-9-]*$/.test(value) ? value : 'host'
}
