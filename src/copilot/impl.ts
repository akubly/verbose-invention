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

type QueueItem =
  | { kind: 'chunk'; value: string }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

/**
 * Adapts an SDK CopilotSession into Reach's CopilotSession interface.
 * Bridges event-emitter streaming → AsyncIterable<string>.
 */
class CopilotSessionAdapter implements CopilotSession {
  constructor(private readonly sdkSession: SdkSession) {}

  send(message: string): AsyncIterable<string> {
    return this.bridge(message);
  }

  private async *bridge(message: string): AsyncGenerator<string> {
    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;

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
          await new Promise<void>((r) => { notify = r; });
          notify = null;
        }
      }
    } finally {
      for (const unsub of unsubs) unsub();
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
  private readonly sdk: SdkClient;
  private started = false;

  constructor(private readonly model = 'claude-sonnet-4') {
    this.sdk = new SdkClient();
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) {
      await this.sdk.start();
      this.started = true;
    }
  }

  async resume(sessionName: string): Promise<CopilotSession | null> {
    await this.ensureStarted();
    const metadata = await this.sdk.getSessionMetadata(sessionName);
    if (!metadata) return null;
    try {
      const sdkSession = await this.sdk.resumeSession(sessionName, {
        model: this.model,
        streaming: true,
        onPermissionRequest: approveAll,
      });
      return new CopilotSessionAdapter(sdkSession);
    } catch {
      // Metadata existed but resume failed (e.g. corrupted data) — treat as absent
      return null;
    }
  }

  async create(sessionName: string): Promise<CopilotSession> {
    await this.ensureStarted();
    const sdkSession = await this.sdk.createSession({
      sessionId: sessionName,
      model: this.model,
      streaming: true,
      onPermissionRequest: approveAll,
    });
    return new CopilotSessionAdapter(sdkSession);
  }

  /** Gracefully stop the SDK client. Call on daemon shutdown. */
  async stop(): Promise<void> {
    if (this.started) {
      const errors = await this.sdk.stop();
      this.started = false;
      if (errors.length > 0) {
        console.error('[copilot] SDK stop errors:', errors);
      }
    }
  }
}
