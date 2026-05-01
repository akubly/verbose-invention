import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── SDK mock wiring ──────────────────────────────────────────────────────────

const mockSdkClient = {
  start: vi.fn().mockResolvedValue(undefined),
  getSessionMetadata: vi.fn(),
  resumeSession: vi.fn(),
  createSession: vi.fn(),
  stop: vi.fn().mockResolvedValue([]),
};

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: vi.fn(() => mockSdkClient),
  approveAll: vi.fn(),
}));

import { CopilotClientImpl } from '../../src/copilot/impl.js';

// ─── Mock SDK session with event-emitter semantics ────────────────────────────

class MockSdkSession {
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  send = vi.fn().mockResolvedValue(undefined);
  unsubFns: ReturnType<typeof vi.fn>[] = [];

  on(event: string, handler: (...args: unknown[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    const unsub = vi.fn(() => {
      this.handlers.get(event)?.delete(handler);
    });
    this.unsubFns.push(unsub);
    return unsub;
  }

  emit(event: string, data?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('CopilotClientImpl', () => {
  let impl: CopilotClientImpl;
  let sdkSession: MockSdkSession;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkSession = new MockSdkSession();
    mockSdkClient.start.mockResolvedValue(undefined);
    mockSdkClient.getSessionMetadata.mockResolvedValue({ id: 'test' });
    mockSdkClient.resumeSession.mockResolvedValue(sdkSession);
    mockSdkClient.createSession.mockResolvedValue(sdkSession);
    mockSdkClient.stop.mockResolvedValue([]);
    impl = new CopilotClientImpl();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── streaming (adapter bridge) ────────────────────────────────────────────

  describe('streaming via bridge', () => {
    it('yields chunks from message_delta and completes on session.idle', async () => {
      sdkSession.send.mockImplementation(async () => {
        queueMicrotask(() => {
          sdkSession.emit('assistant.message_delta', { data: { deltaContent: 'Hello' } });
          sdkSession.emit('assistant.message_delta', { data: { deltaContent: ' world' } });
          sdkSession.emit('session.idle');
        });
      });

      const session = await impl.create('test');
      const chunks = await collect(session.send('Hi'));

      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('throws on session.error', async () => {
      sdkSession.send.mockImplementation(async () => {
        queueMicrotask(() => {
          sdkSession.emit('session.error', { data: { message: 'SDK exploded' } });
        });
      });

      const session = await impl.create('test');
      await expect(collect(session.send('Hi'))).rejects.toThrow('SDK exploded');
    });

    it('throws when sdkSession.send() rejects', async () => {
      sdkSession.send.mockRejectedValue(new Error('send failed'));

      const session = await impl.create('test');
      await expect(collect(session.send('Hi'))).rejects.toThrow('send failed');
    });
  });

  // ── listener cleanup ──────────────────────────────────────────────────────

  describe('listener cleanup', () => {
    it('unsubscribes all listeners after successful stream', async () => {
      sdkSession.send.mockImplementation(async () => {
        queueMicrotask(() => {
          sdkSession.emit('assistant.message_delta', { data: { deltaContent: 'x' } });
          sdkSession.emit('session.idle');
        });
      });

      const session = await impl.create('test');
      await collect(session.send('Hi'));

      expect(sdkSession.unsubFns).toHaveLength(3);
      for (const unsub of sdkSession.unsubFns) {
        expect(unsub).toHaveBeenCalledOnce();
      }
      expect(sdkSession.listenerCount('assistant.message_delta')).toBe(0);
      expect(sdkSession.listenerCount('session.idle')).toBe(0);
      expect(sdkSession.listenerCount('session.error')).toBe(0);
    });

    it('unsubscribes all listeners after error', async () => {
      sdkSession.send.mockImplementation(async () => {
        queueMicrotask(() => {
          sdkSession.emit('session.error', { data: { message: 'boom' } });
        });
      });

      const session = await impl.create('test');
      await expect(collect(session.send('Hi'))).rejects.toThrow();

      expect(sdkSession.listenerCount('assistant.message_delta')).toBe(0);
      expect(sdkSession.listenerCount('session.idle')).toBe(0);
      expect(sdkSession.listenerCount('session.error')).toBe(0);
    });
  });

  // ── send() serialization ──────────────────────────────────────────────────

  describe('send() serialization', () => {
    it('second send() waits for the first to complete', async () => {
      const sdkSendOrder: number[] = [];
      let sendCount = 0;

      sdkSession.send.mockImplementation(async () => {
        const n = ++sendCount;
        sdkSendOrder.push(n);
        queueMicrotask(() => {
          sdkSession.emit('assistant.message_delta', { data: { deltaContent: `chunk-${n}` } });
          sdkSession.emit('session.idle');
        });
      });

      const session = await impl.create('test');
      const iter1 = session.send('first');
      const iter2 = session.send('second');

      const [chunks1, chunks2] = await Promise.all([collect(iter1), collect(iter2)]);

      expect(chunks1).toEqual(['chunk-1']);
      expect(chunks2).toEqual(['chunk-2']);
      expect(sdkSendOrder).toEqual([1, 2]);
      expect(sdkSession.send).toHaveBeenCalledTimes(2);
    });
  });

  // ── timeout ───────────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('rejects when no events arrive within the timeout window', async () => {
      vi.useFakeTimers();
      // send resolves but never emits any events
      sdkSession.send.mockResolvedValue(undefined);

      const session = await impl.create('test');
      const promise = collect(session.send('Hi'));
      // Attach a no-op catch so the rejection isn't "unhandled" during timer advancement
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

      await expect(promise).rejects.toThrow('Stream timeout');
    });
  });

  // ── resume() ──────────────────────────────────────────────────────────────

  describe('resume()', () => {
    it('returns null when session metadata is missing', async () => {
      mockSdkClient.getSessionMetadata.mockResolvedValue(null);

      const result = await impl.resume('nonexistent');

      expect(result).toBeNull();
      expect(mockSdkClient.resumeSession).not.toHaveBeenCalled();
    });

    it('returns null when resumeSession throws "not found"', async () => {
      mockSdkClient.resumeSession.mockRejectedValue(new Error('Session not found'));

      const result = await impl.resume('missing');

      expect(result).toBeNull();
    });

    it('returns null when resumeSession throws "does not exist"', async () => {
      mockSdkClient.resumeSession.mockRejectedValue(
        new Error('Session does not exist'),
      );

      const result = await impl.resume('gone');

      expect(result).toBeNull();
    });

    it('propagates real errors from resumeSession', async () => {
      mockSdkClient.resumeSession.mockRejectedValue(new Error('Network failure'));

      await expect(impl.resume('broken')).rejects.toThrow('Network failure');
    });

    it('returns a working session on successful resume', async () => {
      sdkSession.send.mockImplementation(async () => {
        queueMicrotask(() => {
          sdkSession.emit('assistant.message_delta', { data: { deltaContent: 'resumed' } });
          sdkSession.emit('session.idle');
        });
      });

      const session = await impl.resume('existing');

      expect(session).not.toBeNull();
      const chunks = await collect(session!.send('Hello'));
      expect(chunks).toEqual(['resumed']);
    });
  });

  // ── Phase 3 Wave 2 features (NOT testable with mocked SDK) ───────────────

  describe('SDK crash recovery (integration-level behavior)', () => {
    // The crash recovery logic (restartCount, lastRestartAt, exponential backoff,
    // resetForRestart()) exists in CopilotClientImpl but cannot be unit tested
    // without importing the real SDK, which these tests explicitly avoid.
    //
    // These features would be verified by:
    // - Integration tests that start the real SDK, simulate crashes, and verify backoff
    // - Manual verification during daemon testing
    //
    // The relevant code paths:
    // - CopilotClientImpl.ensureStarted() checks restartCount and delays if needed
    // - CopilotClientImpl.resetForRestart() nulls out startPromise
    // - Relay calls factory.resetForRestart() on non-timeout SDK errors

    it.skip('would test exponential backoff after rapid restarts', () => {
      // Cannot test: requires real SDK lifecycle events
    });

    it.skip('would test resetForRestart() nulls out startPromise', () => {
      // Cannot test: startPromise is private and SDK mock is too coarse
    });
  });

  describe('Permission policy (integration-level behavior)', () => {
    it('maps shell requests to the platform shell tool name', async () => {
      const promptCallback = vi.fn().mockResolvedValue(true);
      const interactiveImpl = new CopilotClientImpl('claude-sonnet-4', 'interactiveDestructive');

      await interactiveImpl.create('test', undefined, promptCallback);

      const createOptions = mockSdkClient.createSession.mock.calls[0]?.[0];
      expect(createOptions?.onPermissionRequest).toBeTypeOf('function');

      const result = await createOptions.onPermissionRequest(
        { kind: 'shell', args: { command: 'echo test' } },
        {},
      );

      expect(promptCallback).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'powershell' : 'bash',
        JSON.stringify({ command: 'echo test' }),
      );
      expect(result).toEqual({ kind: 'approved' });
    });

    it.skip('would test makePermissionHandler returns approveAll for approveAll policy', () => {
      // Cannot test: makePermissionHandler is not exported
    });

    it.skip('would test makePermissionHandler returns denyAll handler for denyAll policy', () => {
      // Cannot test: makePermissionHandler is not exported
    });
  });
});
