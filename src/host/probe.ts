/** Extracts the first semantic-looking version token from command output. */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1]
}
