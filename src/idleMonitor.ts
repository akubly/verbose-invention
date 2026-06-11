const raw = Number(process.env.IDLE_TIMEOUT_MS ?? 300_000);
const IDLE_TIMEOUT_MS = Number.isFinite(raw) && raw > 0 ? raw : 300_000;

/**
 * Tracks per-thread idle timers (keyed by opaque string threadId).
 * When a thread's timer fires, the callback evicts its in-memory SDK session.
 * The registry entry (sessionName) is kept — the session is recreated lazily
 * on the next message.
 */
export class IdleMonitor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Reset the idle timer for a thread. Call this on every relayed message.
   * @param threadId The opaque thread identifier.
   * @param onIdle  Called when the thread has been idle for IDLE_TIMEOUT_MS.
   */
  reset(threadId: string, onIdle: () => void): void {
    const existing = this.timers.get(threadId);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(threadId, setTimeout(() => {
      this.timers.delete(threadId);
      onIdle();
    }, IDLE_TIMEOUT_MS));
  }

  /** Cancel the idle timer for a thread (e.g. when the thread is removed). */
  cancel(threadId: string): void {
    const existing = this.timers.get(threadId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(threadId);
    }
  }

  /** Cancel all timers (e.g. on graceful shutdown). */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
