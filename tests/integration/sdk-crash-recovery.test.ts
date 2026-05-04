/**
 * Integration test: relay-level SDK crash recovery.
 *
 * Tests relay-level crash recovery behavior across the relay/factory contract.
 * Verifies that SDK-like failures trigger the expected restart/reset interactions.
 *
 * Note: Uses factory stubs here; CopilotClientImpl backoff coverage lives
 * separately from this suite (see tests/copilot/impl.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import { StreamTimeoutError } from '../../src/copilot/impl.js';
import type { SessionEntry } from '../../src/types.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { CopilotSession } from '../../src/copilot/factory.js';
import { escapeMarkdownV2 } from '../../src/relay/markdownV2.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal grammY Context double for relay tests. */
function makeMockCtx(
  text = 'Hello Copilot',
  topicId: number | undefined | null = 42,
  chatId = -1001234567890,
) {
  return {
    message: topicId !== undefined && topicId !== null
      ? { message_thread_id: topicId, text }
      : { text },
    chat: { id: chatId },
    reply: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: chatId } }),
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

/** Stub SessionLookup for integration tests. */
function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return {
    resolve: vi.fn((topicId: number) => map.get(topicId)),
  };
}

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-crash-test',
  topicId: 42,
  chatId: -1001234567890,
  createdAt: '2024-01-01T00:00:00.000Z',
};

// ─── tests ────────────────────────────────────────────────────────────────────

// Uses factory stubs by design so this suite can focus on Relay's contract with
// the factory interface. CopilotClientImpl backoff logic is tested separately
// in tests/copilot/impl.test.ts.
describe('Integration: relay-level SDK crash recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── relay error → factory restart ─────────────────────────────────────────────

  it('relay calls factory.resetForRestart() on SDK crash error', async () => {
    // Create a factory that throws on session.send()
    const crashingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new Error('SDK connection lost');
        },
      }),
    };

    const factory = {
      resume: vi.fn().mockResolvedValue(crashingSession),
      create: vi.fn().mockResolvedValue(crashingSession),
      resetForRestart: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');
    const ctx = makeMockCtx();

    await relay.relay(ctx as any);

    // Verify resetForRestart was called on SDK error
    expect(factory.resetForRestart).toHaveBeenCalledOnce();
  });

  it('relay does NOT call resetForRestart() on timeout error', async () => {
    // Create a factory that throws timeout error
    const timeoutSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new StreamTimeoutError();
        },
      }),
    };

    const factory = {
      resume: vi.fn().mockResolvedValue(timeoutSession),
      create: vi.fn().mockResolvedValue(timeoutSession),
      resetForRestart: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');
    const ctx = makeMockCtx();

    await relay.relay(ctx as any);

    // Verify resetForRestart was NOT called on timeout
    expect(factory.resetForRestart).not.toHaveBeenCalled();
  });

  it('relay clears all cached sessions on SDK crash', async () => {
    // Setup factory that crashes, then returns working session
    let callCount = 0;
    const crashingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new Error('SDK crashed');
        },
      }),
    };

    const workingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield 'Recovered response';
        },
      }),
    };

    const factory = {
      resume: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? crashingSession : workingSession;
      }),
      create: vi.fn(),
      resetForRestart: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');

    // First call crashes
    await relay.relay(makeMockCtx() as any);

    // Second call should resume from factory again (cache was cleared)
    await relay.relay(makeMockCtx() as any);

    // Verify factory.resume was called twice (cache was cleared after crash)
    expect(factory.resume).toHaveBeenCalledTimes(2);
  });

  // ── factory restart workflow ──────────────────────────────────────────────────

  it('factory creates new session after resetForRestart()', async () => {
    // Create a mock factory that tracks restart state
    let crashed = false;
    const crashingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new Error('SDK crashed');
        },
      }),
    };

    const workingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield 'Recovery successful';
        },
      }),
    };

    const factory = {
      resume: vi.fn().mockImplementation(() => {
        return crashed ? null : crashingSession;
      }),
      create: vi.fn().mockResolvedValue(workingSession),
      resetForRestart: vi.fn().mockImplementation(() => {
        crashed = true;
      }),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');

    // First call — SDK crashes
    const ctx1 = makeMockCtx('test message 1');
    await relay.relay(ctx1 as any);
    expect(factory.resetForRestart).toHaveBeenCalledOnce();

    // Second call — factory should create new session
    const ctx2 = makeMockCtx('test message 2');
    await relay.relay(ctx2 as any);

    // Verify the working session was used
    expect(factory.create).toHaveBeenCalledWith('reach-crash-test', undefined, undefined);
    expect(workingSession.send).toHaveBeenCalled();
  });

  // ── cache/reset behavior ──────────────────────────────────────────────────────

  it('relay continues to process messages after cached session is cleared', async () => {
    // Test that relay re-fetches session after cache is cleared
    let createCallCount = 0;
    const factory = {
      resume: vi.fn().mockResolvedValue(null), // Always return null (no existing session)
      create: vi.fn().mockImplementation(async () => {
        createCallCount++;
        return {
          send: vi.fn().mockReturnValue({
            async *[Symbol.asyncIterator]() {
              yield `Response ${createCallCount}`;
            },
          }),
        };
      }),
      resetForRestart: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');

    // First message — creates session
    await relay.relay(makeMockCtx('message 1') as any);
    expect(factory.create).toHaveBeenCalledTimes(1);

    // Dispose relay (clears cache)
    relay.dispose();

    // Second message — should create new session (cache was cleared)
    await relay.relay(makeMockCtx('message 2') as any);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  // ── end-to-end recovery scenario ──────────────────────────────────────────────

  it('completes relay-level recovery cycle: crash → reset → recreate → success', async () => {
    let restartCount = 0;
    let sessionCreateCount = 0;

    const crashingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new Error('SDK crashed');
        },
      }),
    };

    const workingSession: CopilotSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield 'Recovered!';
        },
      }),
    };

    const factory = {
      resume: vi.fn().mockImplementation(() => {
        sessionCreateCount++;
        return sessionCreateCount === 1 ? crashingSession : null;
      }),
      create: vi.fn().mockImplementation(() => {
        sessionCreateCount++;
        return workingSession;
      }),
      resetForRestart: vi.fn().mockImplementation(() => {
        restartCount++;
      }),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');

    // Step 1: First message triggers crash
    const ctx1 = makeMockCtx('trigger crash');
    await relay.relay(ctx1 as any);

    expect(restartCount).toBe(1);
    expect(factory.resetForRestart).toHaveBeenCalledOnce();

    // Step 2: Second message triggers recovery
    const ctx2 = makeMockCtx('test recovery');
    await relay.relay(ctx2 as any);

    expect(factory.resume).toHaveBeenCalledTimes(2); // First + recovery
    expect(factory.create).toHaveBeenCalledOnce();

    // Step 3: Verify final message was edited with success
    const editCalls = (ctx2.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
    const finalText = editCalls[editCalls.length - 1][2] as string;
    expect(finalText).toContain(escapeMarkdownV2('Recovered!'));
  });

  it('handles multiple sequential crashes by resetting the factory each time', async () => {
    const crashingSessions: CopilotSession[] = [1, 2, 3].map(() => ({
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new Error('SDK crashed');
        },
      }),
    }));

    let crashIndex = 0;
    const factory = {
      resume: vi.fn().mockImplementation(() => {
        if (crashIndex < crashingSessions.length) {
          return crashingSessions[crashIndex++];
        }
        return null;
      }),
      create: vi.fn().mockResolvedValue({
        send: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield 'Finally recovered';
          },
        }),
      }),
      resetForRestart: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');

    // Trigger multiple crashes
    for (let i = 0; i < 3; i++) {
      await relay.relay(makeMockCtx(`crash ${i + 1}`) as any);
    }

    // Verify resetForRestart was called for each crash
    expect(factory.resetForRestart).toHaveBeenCalledTimes(3);
  });
});
