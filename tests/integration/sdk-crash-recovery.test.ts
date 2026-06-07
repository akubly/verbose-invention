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
import type { ChannelPort, ChannelContext } from '../../src/channel/port.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMockChannel(): ChannelPort {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: '100' }),
    editMessage: vi.fn().mockResolvedValue(true),
    splitMessage: vi.fn((text: string, footer?: string) => footer ? [`${text}\n\n${footer}`] : [text]),
    formatForTransport: vi.fn((text: string) => text),
    createThread: vi.fn(),
    onMessage: vi.fn(),
    onCommand: vi.fn(),
    promptUser: vi.fn().mockResolvedValue('approve'),
    capabilities: {
      supportsMessageEdit: true,
      supportsThreadCreation: true,
      supportsInteractivePrompts: true,
      supportsStreaming: true,
      maxMessageLength: 4096,
    },
  } as unknown as ChannelPort;
}

const DEFAULT_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };
const DEFAULT_TEXT = 'Hello Copilot';

/** Stub SessionLookup for integration tests. */
function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.threadId, e]));
  return {
    resolve: vi.fn((threadId: string) => map.get(threadId)),
  };
}

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-crash-test',
  threadId: '42',
  channelId: '-1001234567890',
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
    const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    // Verify resetForRestart was called on SDK error
    expect(factory.resetForRestart).toHaveBeenCalledOnce();
  });

  it('relay does NOT call resetForRestart() on timeout error', async () => {
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
    const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    // Verify resetForRestart was NOT called on timeout
    expect(factory.resetForRestart).not.toHaveBeenCalled();
  });

  it('relay clears all cached sessions on SDK crash', async () => {
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
    const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

    // First call crashes
    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    // Second call should resume from factory again (cache was cleared)
    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    // Verify factory.resume was called twice (cache was cleared after crash)
    expect(factory.resume).toHaveBeenCalledTimes(2);
  });

  // ── factory restart workflow ──────────────────────────────────────────────────

  it('factory creates new session after resetForRestart()', async () => {
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
    const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

    // First call — SDK crashes
    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    expect(factory.resetForRestart).toHaveBeenCalledOnce();

    // Second call — factory should create new session
    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    // Verify the working session was used
    expect(factory.create).toHaveBeenCalledWith('reach-crash-test', undefined, undefined);
    expect(workingSession.send).toHaveBeenCalled();
  });

  // ── cache/reset behavior ──────────────────────────────────────────────────────

  it('relay continues to process messages after cached session is cleared', async () => {
    let createCallCount = 0;
    const factory = {
      resume: vi.fn().mockResolvedValue(null),
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
    const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

    // First message — creates session
    await relay.relay(DEFAULT_CTX, 'message 1');
    expect(factory.create).toHaveBeenCalledTimes(1);

    // Dispose relay (clears cache)
    relay.dispose();

    // Second message — should create new session (cache was cleared)
    await relay.relay(DEFAULT_CTX, 'message 2');
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
    const channel = makeMockChannel();
    const relay = new Relay(channel, registry, factory, 'test-model');

    // Step 1: First message triggers crash
    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    expect(restartCount).toBe(1);
    expect(factory.resetForRestart).toHaveBeenCalledOnce();

    // Step 2: Second message triggers recovery
    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    expect(factory.resume).toHaveBeenCalledTimes(2);
    expect(factory.create).toHaveBeenCalledOnce();

    // Step 3: Verify final message was edited with the recovered content
    const editCalls = (channel.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const finalText = editCalls[editCalls.length - 1][2] as string;
    expect(finalText).toContain('Recovered!');
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
    const relay = new Relay(makeMockChannel(), registry, factory, 'test-model');

    // Trigger multiple crashes
    for (let i = 0; i < 3; i++) {
      await relay.relay(DEFAULT_CTX, `crash ${i + 1}`);
    }

    // Verify resetForRestart was called for each crash
    expect(factory.resetForRestart).toHaveBeenCalledTimes(3);
  });
});
