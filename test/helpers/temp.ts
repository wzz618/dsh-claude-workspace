import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Creates an isolated directory under the OS temp root. */
export async function makeTempDir(prefix = 'ccw-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Removes a directory tree, ignoring a second cleanup. */
export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Polls until `probe` returns a truthy value or the timeout expires. */
export async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Async variant of {@link waitFor} for store or network reads. */
export async function waitForAsync<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error('waitForAsync timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
