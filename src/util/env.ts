/** Environment variables removed before starting Claude Code. */
const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
]

/** Prefixes whose variables never reach the agent process. */
const CREDENTIAL_PREFIXES = ['DSH_', 'AWS_', 'AZURE_', 'GCP_', 'GOOGLE_CLOUD_']

/**
 * Builds the agent environment from the host process environment.
 *
 * The agent keeps `HOME`, `PATH`, locale, and its own Claude configuration
 * variables so it uses the login and settings already present on the host.
 * DSH-specific and credential-bearing variables are removed: the plugin must
 * not leak its own secrets into a process it does not control. Explicit host
 * `env` entries are applied last and are the documented way to add values.
 *
 * @param env - Source environment.
 * @param overrides - Values from the resolved host configuration.
 * @returns A new environment map.
 */
export function scrubEnvironment(
  env: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (CREDENTIAL_VARIABLES.includes(key)) continue
    if (CREDENTIAL_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    result[key] = value
  }
  return { ...result, ...overrides }
}
