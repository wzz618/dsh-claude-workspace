/**
 * Quotes one argument for a POSIX shell.
 *
 * The result always uses single quotes, so spaces, `$()`, backticks, globs,
 * quotes, and non-ASCII bytes reach the remote command unchanged. SSH joins its
 * arguments with spaces before the remote shell parses them, so every argument
 * is quoted independently.
 *
 * @param argument - Raw argument.
 * @returns A single-quoted shell word.
 */
export function quotePosix(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

/**
 * Builds the command string SSH passes to the remote shell.
 *
 * @param argv - Executable and arguments, already separated.
 * @returns A space-joined, quoted command line.
 */
export function buildRemoteCommand(argv: readonly string[]): string {
  return argv.map(quotePosix).join(' ')
}
