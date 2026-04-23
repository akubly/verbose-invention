/**
 * Real @github/copilot-sdk binding for Reach.
 *
 * Implements CopilotSessionFactory by adapting the SDK's event-emitter
 * streaming model into the AsyncIterable<string> contract the relay expects.
 *
 * @see docs/adr-001-copilot-sdk-binding.md
 */

import {
  CopilotClient as SdkClient,
  type CopilotSession as SdkSession,
  approveAll,
} from '@github/copilot-sdk';
import type { CopilotSession, CopilotSessionFactory } from './factory.js';

const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

export type PermissionPolicy = 'approveAll' | 'denyAll';

export class StreamTimeoutError extends Error {
  constructor() { super('Stream timeout: no response from SDK'); }
}

function makePermissionHandler(policy: PermissionPolicy) {
  if (policy === 'approveAll') return approveAll;
  if (policy === 'denyAll') {
    return async () => ({ kind: 'denied-by-rules' as const, rules: [] });
  }
  throw new Error(`Invalid permission policy: ${policy}`);
}

type QueueItem =
  | { kind: 'chunk'; value: string }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

/**
 * Adapts an SDK CopilotSession into Reach's CopilotSession interface.
 * Bridges event-emitter streaming → AsyncIterable<string>.
 */
class CopilotSessionAdapter implements CopilotSession {
  /** Serializes send() calls so only one generator is active at a time. */
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly sdkSession: SdkSession) {}

  send(message: string): AsyncIterable<string> {
    return this.bridge(message);
  }

  private async *bridge(message: string): AsyncGenerator<string> {
    // Acquire the serialization lock inside the generator body so it only
    // runs when the caller actually starts iterating (first next() call).
    // This avoids a deadlock when the returned iterable is never consumed.
    let releaseLock!: () => void;
    const gate = this.sendQueue;
    this.sendQueue = new Promise<void>((resolve) => { releaseLock = resolve; });

    // Wait for any prior send() to finish before subscribing to events
    await gate;
    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const push = (item: QueueItem) => {
      queue.push(item);
      notify?.();
    };

    // Subscribe BEFORE sending so no events are missed
    const unsubs = [
      this.sdkSession.on('assistant.message_delta', (event) => {
        push({ kind: 'chunk', value: event.data.deltaContent });
      }),
      this.sdkSession.on('session.idle', () => {
        push({ kind: 'done' });
      }),
      this.sdkSession.on('session.error', (event) => {
        push({ kind: 'error', error: new Error(event.data.message) });
      }),
    ];

    try {
      // Fire-and-forget: send() triggers the agentic loop; events flow via listeners
      this.sdkSession.send({ prompt: message }).catch((err: unknown) => {
        push({
          kind: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

      while (true) {
        if (queue.length > 0) {
          const item = queue.shift()!;
          switch (item.kind) {
            case 'chunk':
              yield item.value;
              break;
            case 'error':
              throw item.error;
            case 'done':
              return;
          }
        } else {
          await Promise.race([
            new Promise<void>((r) => {
              notify = r;
              // Re-check after assigning — events may have arrived in the gap
              if (queue.length > 0) r();
            }),
            new Promise<void>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new StreamTimeoutError()),
                STREAM_TIMEOUT_MS,
              );
            }),
          ]);
          clearTimeout(timeoutId);
          timeoutId = undefined;
          notify = null;
        }
      }
    } finally {
      clearTimeout(timeoutId);
      for (const unsub of unsubs) unsub();
      releaseLock();
    }
  }
}

/**
 * Production CopilotSessionFactory backed by @github/copilot-sdk.
 *
 * Holds a single SDK CopilotClient for the daemon lifetime.
 * Starts the SDK lazily on first resume/create call.
 */
export class CopilotClientImpl implements CopilotSessionFactory {
  private sdk!: SdkClient;
  private startPromise: Promise<void> | null = null;
  private restartCount = 0;
  private lastRestartAt = 0;
  private backoffResetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly model = 'claude-sonnet-4',
    private readonly permissionPolicy: PermissionPolicy = 'approveAll',
  ) {}

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = (async () => {
        // Backoff if restarting too quickly
        const now = Date.now();
        if (this.restartCount > 0 && now - this.lastRestartAt < 60_000) {
          const retryIndex = this.restartCount - 1;
          const delay = Math.min(1000 * Math.pow(2, retryIndex), 30_000);
          console.warn(`[copilot] SDK restart backoff: ${delay}ms (attempt ${this.restartCount + 1})`);
          await new Promise(r => setTimeout(r, delay));
        }
        this.lastRestartAt = Date.now();
        this.restartCount++;
        
        this.sdk = new SdkClient();
        await this.sdk.start();
        
        // Reset backoff after 60s of successful uptime
        clearTimeout(this.backoffResetTimer);
        this.backoffResetTimer = setTimeout(() => { this.restartCount = 0; }, 60_000);
      })().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  async resume(sessionName: string, model?: string): Promise<CopilotSession | null> {
    await this.ensureStarted();
    const metadata = await this.sdk.getSessionMetadata(sessionName);
    if (!metadata) return null;
    try {
      const sdkSession = await this.sdk.resumeSession(sessionName, {
        model: model ?? this.model,
        streaming: true,
        onPermissionRequest: makePermissionHandler(this.permissionPolicy),
      });
      return new CopilotSessionAdapter(sdkSession);
    } catch (err) {
      if (err instanceof Error && (err.message.includes('not found') || err.message.includes('does not exist'))) {
        return null;
      }
      throw err;
    }
  }

  async create(sessionName: string, model?: string): Promise<CopilotSession> {
    await this.ensureStarted();
    const sdkSession = await this.sdk.createSession({
      sessionId: sessionName,
      model: model ?? this.model,
      streaming: true,
      onPermissionRequest: makePermissionHandler(this.permissionPolicy),
    });
    return new CopilotSessionAdapter(sdkSession);
  }

  /** Called by relay on SDK errors to force restart on next call. */
  resetForRestart(): void {
    const oldPromise = this.startPromise;
    const oldSdk = this.sdk;
    this.startPromise = null;
    clearTimeout(this.backoffResetTimer);
    if (oldPromise) {
      oldPromise.then(() => oldSdk?.stop?.()).catch(() => {});
    }
    console.log('[copilot] SDK marked for restart on next call');
  }

  /** Gracefully stop the SDK client. Call on daemon shutdown. */
  async stop(): Promise<void> {
    clearTimeout(this.backoffResetTimer);
    if (this.startPromise) {
      await this.startPromise;
      const errors = await this.sdk.stop();
      this.startPromise = null;
      if (errors.length > 0) {
        console.error('[copilot] SDK stop errors:', errors);
      }
    }
  }
}
