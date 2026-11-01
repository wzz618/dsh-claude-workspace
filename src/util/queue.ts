/**
 * Runs tasks one at a time per key. Failures do not poison later tasks, and a
 * key is removed from the map once its chain drains so an idle process retains
 * no unbounded state.
 */
export class SerialQueue {
  readonly #tails = new Map<string, Promise<void>>()

  /**
   * Queues `task` behind earlier work for `key`.
   *
   * @param key - Serialization key, for example a workspace id or file path.
   * @param task - Work to run once every earlier task for `key` settles.
   * @returns The task's own result or rejection.
   */
  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#tails.set(key, tail)
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return result
  }

  /** Resolves when every queued task has settled. */
  async drain(): Promise<void> {
    while (this.#tails.size > 0) {
      await Promise.allSettled([...this.#tails.values()])
    }
  }
}
