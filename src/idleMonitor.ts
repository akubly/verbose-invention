const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 300_000); // default 5 minutes

/**
 * Tracks per-topic idle timers.
 * When a topic's timer fires, the callback evicts its in-memory SDK session.
 * The registry entry (sessionName) is kept — the session is recreated lazily
 * on the next message.
 */
export class IdleMonitor {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Reset the idle timer for a topic. Call this on every relayed message.
   * @param topicId The forum topic ID.
   * @param onIdle  Called when the topic has been idle for IDLE_TIMEOUT_MS.
   */
  reset(topicId: number, onIdle: () => void): void {
    const existing = this.timers.get(topicId);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(topicId, setTimeout(() => {
      this.timers.delete(topicId);
      onIdle();
    }, IDLE_TIMEOUT_MS));
  }

  /** Cancel the idle timer for a topic (e.g. when the topic is removed). */
  cancel(topicId: number): void {
    const existing = this.timers.get(topicId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(topicId);
    }
  }

  /** Cancel all timers (e.g. on graceful shutdown). */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
