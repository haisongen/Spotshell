/** Serialize asynchronous tasks by key without letting a rejection poison the queue. */
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve()
    const next = tail.then(fn, fn)
    this.tails.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }
}
