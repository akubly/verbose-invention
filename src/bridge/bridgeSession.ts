/**
 * bridgeSession.ts — Adapter: ExtensionBridge → CopilotSession.
 *
 * BridgeSession wraps the push-based bridge event model (stream / stream.error)
 * into the AsyncIterable<string> contract that relay.ts expects, so the relay's
 * 800ms throttle, accumulation cap, MarkdownV2 fallback, and error handling
 * all apply to bridge-backed sessions without any changes to relay.ts (ADR-8, Option A).
 *
 * Listener cleanup is guaranteed via try/finally: bridge.off() fires on normal
 * completion, on error, and if the consumer abandons the iterator early.
 */

import type { BridgeEmitter } from './extensionBridge.js';
import type { CopilotSession } from '../copilot/factory.js';

type QueueItem =
  | { kind: 'chunk'; value: string }
  | { kind: 'done' }
  | { kind: 'error'; err: Error };

export class BridgeSession implements CopilotSession {
  /**
   * @param bridge   - Typed event subscriber (on/off). Accepts a real ExtensionBridge
   *                   or any fake that implements BridgeEmitter — keeping this testable.
   * @param sessionId - The bridge session ID used to correlate commands and events.
   * @param sendFn   - Injects text into the session; returns a requestId for correlation,
   *                   or `false` if the session is unreachable.
   */
  constructor(
    private readonly bridge: BridgeEmitter,
    private readonly sessionId: string,
    private readonly sendFn: (sessionId: string, text: string) => string | false,
  ) {}

  send(text: string): AsyncIterable<string> {
    return this._generateStream(text);
  }

  private async *_generateStream(text: string): AsyncGenerator<string> {
    const requestId = this.sendFn(this.sessionId, text);
    if (requestId === false) {
      throw new Error(`Session ${this.sessionId} unreachable`);
    }

    // Push-to-pull bridge: listeners push items into the queue and wake the generator.
    const queue: QueueItem[] = [];
    let signal: (() => void) | null = null;
    const wake = (): void => {
      const s = signal;
      signal = null;
      s?.();
    };

    // Filter by requestId to ignore events from other concurrent sessions/sends.
    const streamListener = (
      _sId: string,
      rId: string,
      chunk: string,
      done: boolean,
    ): void => {
      if (rId !== requestId) return;
      // The final frame may carry both a non-empty chunk AND done: true — yield both.
      if (chunk.length > 0) queue.push({ kind: 'chunk', value: chunk });
      if (done) queue.push({ kind: 'done' });
      wake();
    };

    const errorListener = (
      _sId: string,
      rId: string,
      error: string,
    ): void => {
      if (rId !== requestId) return;
      queue.push({ kind: 'error', err: new Error(error) });
      wake();
    };

    this.bridge.on('stream', streamListener);
    this.bridge.on('stream.error', errorListener);

    try {
      while (true) {
        // Drain all queued items before waiting.
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.kind === 'chunk') {
            yield item.value;
          } else if (item.kind === 'done') {
            return;
          } else {
            throw item.err;
          }
        }
        // Wait for the next push. Re-check queue after assigning signal to close
        // the race window between the empty-queue check and the await.
        await new Promise<void>((r) => {
          signal = r;
          if (queue.length > 0) {
            signal = null;
            r();
          }
        });
      }
    } finally {
      // Guaranteed cleanup: runs on normal completion, error, AND early iterator abandonment.
      this.bridge.off('stream', streamListener as (...args: unknown[]) => void);
      this.bridge.off('stream.error', errorListener as (...args: unknown[]) => void);
    }
  }
}
