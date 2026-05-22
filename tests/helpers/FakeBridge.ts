/**
 * FakeBridge — in-process BridgeEmitter double for BridgeSession tests.
 *
 * Lets tests:
 *  - Trigger `stream` / `stream.error` events deterministically via
 *    `emitStream()` / `emitStreamError()`.
 *  - Assert listener registration and cleanup via `onCalls` / `offCalls`.
 *    Both arrays record the exact listener reference so tests can verify
 *    that `off()` was called with the same function passed to `on()`.
 *
 * For BridgeSessionFactory tests that also need `getSession()` /
 * `sendCommand()`, build a partial vi.fn() mock of ExtensionBridge directly
 * rather than extending FakeBridge — those methods belong to the full bridge
 * class, not the BridgeEmitter subscriber interface.
 */

import { EventEmitter } from 'node:events';
import type { BridgeEmitter } from '../../src/bridge/extensionBridge.js';

export interface OnOffRecord {
  event: string;
  /** The exact listener reference passed to on() / off(). */
  listener: (...args: unknown[]) => void;
}

export class FakeBridge implements BridgeEmitter {
  private readonly _emitter = new EventEmitter();

  /** Ordered list of all bridge.on() calls (event + listener reference). */
  readonly onCalls: OnOffRecord[] = [];
  /** Ordered list of all bridge.off() calls (event + listener reference). */
  readonly offCalls: OnOffRecord[] = [];

  // ── BridgeEmitter overloads ────────────────────────────────────────────────

  on(event: 'session.registered', listener: (sessionId: string) => void): this;
  on(event: 'session.disconnected', listener: (sessionId: string) => void): this;
  on(event: 'session.event', listener: (sessionId: string, payload: unknown) => void): this;
  on(
    event: 'stream',
    listener: (sessionId: string, requestId: string, chunk: string, done: boolean) => void,
  ): this;
  on(
    event: 'stream.error',
    listener: (sessionId: string, requestId: string, error: string) => void,
  ): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    this.onCalls.push({ event, listener: listener as (...args: unknown[]) => void });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this._emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.offCalls.push({ event, listener });
    this._emitter.off(event, listener);
    return this;
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  /** Synchronously emit a `stream` event to all registered listeners. */
  emitStream(sessionId: string, requestId: string, chunk: string, done: boolean): void {
    this._emitter.emit('stream', sessionId, requestId, chunk, done);
  }

  /** Synchronously emit a `stream.error` event to all registered listeners. */
  emitStreamError(sessionId: string, requestId: string, error: string): void {
    this._emitter.emit('stream.error', sessionId, requestId, error);
  }

  /** Reset tracking state (does NOT remove registered listeners from the emitter). */
  reset(): void {
    this.onCalls.length = 0;
    this.offCalls.length = 0;
  }
}
