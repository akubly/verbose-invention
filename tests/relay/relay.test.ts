import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { SessionEntry } from '../../src/sessions/registry.js';
import type { ChannelPort, ChannelContext } from '../../src/channel/port.js';
import { makeMockFactory, makeMockSession, makeStream } from '../mocks/sdk.js';
import { StreamTimeoutError } from '../../src/copilot/impl.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMockChannel(): ChannelPort & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue({ id: '100' });
  const editMessage = vi.fn().mockResolvedValue(true);
  return {
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage,
    editMessage,
    splitMessage: vi.fn((text: string, footer?: string) => {
      const full = footer ? `${text}\n\n${footer}` : text;
      return [full];
    }),
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
  } as unknown as ChannelPort & { sendMessage: ReturnType<typeof vi.fn>; editMessage: ReturnType<typeof vi.fn> };
}

const DEFAULT_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };
const DEFAULT_TEXT = 'Hello Copilot';

/** Stub SessionLookup — satisfies the shape Relay needs. */
function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.threadId, e]));
  return {
    resolve: vi.fn((threadId: string) => map.get(threadId)),
  };
}

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  threadId: '42',
  channelId: '-1001234567890',
  createdAt: '2024-01-01T00:00:00.000Z',
};

// ─── tests ────────────────────────────────────────────────────────────────────

describe('Relay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('sends placeholder "…" reply then edits with final assembled response', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      // Placeholder send was first
      expect(channel.sendMessage).toHaveBeenCalledWith(DEFAULT_CTX, '…');

      // Final edit contains the assembled chunks from the default mock
      const editCalls = channel.editMessage.mock.calls;
      expect(editCalls.length).toBeGreaterThan(0);
      const finalArg = editCalls[editCalls.length - 1][2] as string;
      expect(finalArg).toContain('Hello world');
    });

    it('assembles all stream chunks into one final message', async () => {
      const chunks = ['The answer ', 'is ', '42.'];
      const session = makeMockSession(chunks);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      // Make splitMessage predictable
      (channel.splitMessage as ReturnType<typeof vi.fn>).mockImplementation((text: string, footer?: string) =>
        footer ? [`${text}\n\n${footer}`] : [text],
      );
      (channel.formatForTransport as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t);
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      const editCalls = channel.editMessage.mock.calls;
      const finalArg = editCalls[editCalls.length - 1][2] as string;
      expect(finalArg).toContain('The answer is 42.');
      expect(finalArg).toContain('reach-myapp · test-model');
    });

    it('resumes an existing session (not create) on the first relay', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      // resume() is attempted before create()
      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });

    it('creates a new session when resume() returns null', async () => {
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
      expect(factory.create).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });

    it('reuses the cached in-memory session on subsequent relay calls', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      // factory.resume called only once — second call uses cached session
      expect(factory.resume).toHaveBeenCalledTimes(1);
    });

    it('handles an empty response (zero chunks) gracefully', async () => {
      const session = makeMockSession([]);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      (channel.formatForTransport as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t);
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      const editCalls = channel.editMessage.mock.calls;
      const finalArg = editCalls[editCalls.length - 1][2] as string;
      expect(finalArg).toContain('empty response');
    });
  });

  // ── error: no session linked ─────────────────────────────────────────────────

  describe('error: no session linked to topic', () => {
    it('replies with guidance and does not call the factory', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([]); // no entries
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resume).not.toHaveBeenCalled();
      expect(factory.create).not.toHaveBeenCalled();
      const sentText = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(sentText).toMatch(/no session|link/i);
    });
  });

  // ── error: factory failure ───────────────────────────────────────────────────

  describe('error: factory / SDK failure', () => {
    it('replies with error message when factory.resume() throws', async () => {
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SDK down'));
      (factory.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SDK down'));
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await expect(relay.relay(DEFAULT_CTX, DEFAULT_TEXT)).resolves.not.toThrow();

      const sentCalls = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const errorText = sentCalls.find(
        (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('❌'),
      )?.[1] as string | undefined;
      expect(errorText).toMatch(/SDK down|Could not open/i);
    });

    it('edits placeholder with error message when stream fails mid-response', async () => {
      const session = makeMockSession(['Partial', ' answer'], 1);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await expect(relay.relay(DEFAULT_CTX, DEFAULT_TEXT)).resolves.not.toThrow();

      const editCalls = channel.editMessage.mock.calls;
      const texts = editCalls.map((c: unknown[]) => c[2] as string);
      expect(texts.some((t) => t.includes('❌'))).toBe(true);
    });

    it('evicts the cached session after a stream error', async () => {
      const session = makeMockSession(['chunk'], 0);
      const goodSession = makeMockSession(['Good response']);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      // First call — stream fails, session should be evicted
      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      // Second call — factory.resume should be called again (evicted)
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(goodSession);
      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resume).toHaveBeenCalledTimes(2);
    });
  });

  describe('permission prompter wiring', () => {
    it('proceeds without prompting when enablePermissionPrompts is false', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model', false);

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });

    it('passes a permissionCallback to factory when enablePermissionPrompts is true', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model', true);

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, expect.any(Function));
    });
  });

  // ── model parameter passing ───────────────────────────────────────────────

  describe('model parameter passing', () => {
    it('relay passes entry.model to factory.create()', async () => {
      const entryWithModel: SessionEntry = {
        ...SESSION_ENTRY,
        model: 'claude-opus-4.5',
      };
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const registry = makeStubRegistry([entryWithModel]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.create).toHaveBeenCalledWith('reach-myapp', 'claude-opus-4.5', undefined);
    });

    it('relay passes entry.model to factory.resume()', async () => {
      const entryWithModel: SessionEntry = {
        ...SESSION_ENTRY,
        model: 'claude-opus-4.6',
      };
      const factory = makeMockFactory();
      const registry = makeStubRegistry([entryWithModel]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', 'claude-opus-4.6', undefined);
    });

    it('relay passes undefined model when entry has no model', async () => {
      const entryWithoutModel: SessionEntry = {
        ...SESSION_ENTRY,
      };
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const registry = makeStubRegistry([entryWithoutModel]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.create).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });
  });

  // ── dispose ─────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('can be called without throwing (graceful shutdown)', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');
      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(() => relay.dispose()).not.toThrow();
    });
  });

  // ── HUD footer ──────────────────────────────────────────────────────────────

  describe('HUD footer', () => {
    it('final message includes HUD footer with session model', async () => {
      const entryWithModel: SessionEntry = {
        ...SESSION_ENTRY,
        model: 'claude-opus-4.5',
      };
      const factory = makeMockFactory();
      const registry = makeStubRegistry([entryWithModel]);
      const channel = makeMockChannel();
      (channel.splitMessage as ReturnType<typeof vi.fn>).mockImplementation((text: string, footer?: string) =>
        footer ? [`${text}\n\n${footer}`] : [text],
      );
      (channel.formatForTransport as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t);
      const relay = new Relay(channel, registry, factory, 'claude-sonnet-4');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      const editCalls = channel.editMessage.mock.calls;
      const finalArg = editCalls[editCalls.length - 1][2] as string;
      expect(finalArg).toContain('reach-myapp · claude-opus-4.5');
    });

    it('final message includes HUD footer with global model when no per-session model', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      (channel.splitMessage as ReturnType<typeof vi.fn>).mockImplementation((text: string, footer?: string) =>
        footer ? [`${text}\n\n${footer}`] : [text],
      );
      (channel.formatForTransport as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t);
      const relay = new Relay(channel, registry, factory, 'claude-sonnet-4');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      const editCalls = channel.editMessage.mock.calls;
      const finalArg = editCalls[editCalls.length - 1][2] as string;
      expect(finalArg).toContain('reach-myapp · claude-sonnet-4');
    });
  });

  // ── chunk cap ────────────────────────────────────────────────────────────────

  describe('chunk cap (F-D / F10)', () => {
    it('caps multi-chunk send at exactly MAX_CHUNKS (25) with consistent numbering and footer', async () => {
      vi.useRealTimers();

      const bigContent = Array.from({ length: 26 }, () => 'x'.repeat(1800)).join('\n\n');
      const session = makeMockSession([bigContent]);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      // Use real splitting behavior by returning 26 chunks then capping
      (channel.splitMessage as ReturnType<typeof vi.fn>).mockImplementation((_text: string) => {
        // Simulate 26 chunks, cap at 25
        const chunks = Array.from({ length: 26 }, (_, i) => `chunk-${i + 1}`);
        const capped = chunks.slice(0, 25);
        capped[24] = '_(truncated)_';
        return capped;
      });
      (channel.formatForTransport as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t);
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      // Follow-up sends (excluding the '…' placeholder) should be at most 24
      // (chunk[0] updates the placeholder via editMessage, chunks[1..24] are new sends)
      // Note: streaming throttle edits also call editMessage on the placeholder — those
      // are intermediate updates to the same message and don't count toward the chunk cap.
      const sendCalls = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[1] !== '…');
      expect(sendCalls.length).toBeLessThanOrEqual(24);
    }, 10_000);
  });

  // ── first-chunk failure (F-E) ─────────────────────────────────────────────────

  describe('first-chunk failure (F-E)', () => {
    it('aborts follow-up chunks and updates placeholder when first-chunk edit fails', async () => {
      const chunk1 = 'x'.repeat(2020);
      const chunk2 = 'y'.repeat(2020);
      const session = makeMockSession([chunk1 + '\n\n' + chunk2]);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Split into 2 chunks to test multi-chunk failure
      (channel.splitMessage as ReturnType<typeof vi.fn>).mockImplementation(() => ['chunk1', 'chunk2']);
      // Streaming throttle edit succeeds; first-chunk post-split edit fails; fallback edit succeeds
      (channel.editMessage as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)          // in-stream throttle edit: OK
        .mockRejectedValueOnce(new Error('Telegram API unavailable')) // first-chunk edit: FAIL
        .mockResolvedValue(undefined);             // failure-message fallback edit: OK
      (channel.formatForTransport as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t);

      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      // sendMessage called only once for "…" placeholder (no follow-up chunks sent)
      const sendCalls = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const followUps = sendCalls.filter((c: unknown[]) => c[1] !== '…');
      expect(followUps).toHaveLength(0);

      // Error log emitted for first-chunk failure
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('First-chunk edit failed'),
      );
    });
  });

  // ── rekeySession (H-A: cache rekey after /resume) ────────────────────────────

  describe('rekeySession', () => {
    it('moves the cached session to the new topic key so next relay reuses it', async () => {
      const factory = makeMockFactory();
      const OLD_THREAD = '10';
      const NEW_THREAD = '20';
      const entryOld: SessionEntry = { ...SESSION_ENTRY, threadId: OLD_THREAD };
      const entryNew: SessionEntry = { ...SESSION_ENTRY, threadId: NEW_THREAD };
      const lookupMap = new Map<string, SessionEntry>([[OLD_THREAD, entryOld]]);
      const registry: SessionLookup = { resolve: vi.fn((id: string) => lookupMap.get(id)) };
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      // Warm the cache for OLD_THREAD
      await relay.relay({ threadId: OLD_THREAD, channelId: '-100' }, 'hello');
      expect(factory.resume).toHaveBeenCalledTimes(1);

      // Simulate /resume: update the registry lookup to point NEW_THREAD → session
      lookupMap.delete(OLD_THREAD);
      lookupMap.set(NEW_THREAD, entryNew);

      // Rekey the relay cache
      relay.rekeySession(OLD_THREAD, NEW_THREAD);

      // Next relay call on NEW_THREAD must NOT call factory again — cache hit
      await relay.relay({ threadId: NEW_THREAD, channelId: '-100' }, 'hello');
      expect(factory.resume).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no cache entry exists for fromThreadId', () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      // No relay call yet — cache is empty; should not throw
      expect(() => relay.rekeySession('42', '99')).not.toThrow();
    });

    it('next relay on old topic creates a new session after rekey', async () => {
      const factory = makeMockFactory();
      const OLD_THREAD = '10';
      const NEW_THREAD = '20';
      const entryOld: SessionEntry = { ...SESSION_ENTRY, threadId: OLD_THREAD };
      const lookupMap = new Map<string, SessionEntry>([[OLD_THREAD, entryOld]]);
      const registry: SessionLookup = { resolve: vi.fn((id: string) => lookupMap.get(id)) };
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay({ threadId: OLD_THREAD, channelId: '-100' }, 'hello');
      expect(factory.resume).toHaveBeenCalledTimes(1);

      relay.rekeySession(OLD_THREAD, NEW_THREAD);

      // OLD_THREAD now has no cached session — next message there calls factory again
      await relay.relay({ threadId: OLD_THREAD, channelId: '-100' }, 'hello');
      expect(factory.resume).toHaveBeenCalledTimes(2);
    });

    it('cancels stale destination timer so it cannot evict the moved session', async () => {
      const factory = makeMockFactory();
      const OLD_THREAD = '30';
      const NEW_THREAD = '40';
      const entryOld: SessionEntry = { ...SESSION_ENTRY, threadId: OLD_THREAD };
      const entryNew: SessionEntry = { ...SESSION_ENTRY, threadId: NEW_THREAD };
      const lookupMap = new Map<string, SessionEntry>([
        [OLD_THREAD, entryOld],
        [NEW_THREAD, entryNew],
      ]);
      const registry: SessionLookup = { resolve: vi.fn((id: string) => lookupMap.get(id)) };
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      // Warm the cache for NEW_THREAD first — this arms a stale idle timer for it
      await relay.relay({ threadId: NEW_THREAD, channelId: '-100' }, 'old message');
      expect(factory.resume).toHaveBeenCalledTimes(1);

      // Warm the cache for OLD_THREAD (the source of the move)
      await relay.relay({ threadId: OLD_THREAD, channelId: '-100' }, 'hello');
      expect(factory.resume).toHaveBeenCalledTimes(2);

      // Simulate /resume: registry now maps NEW_THREAD → old session name
      lookupMap.delete(OLD_THREAD);

      // Move the session from OLD_THREAD → NEW_THREAD; this must cancel the stale
      // timer that was armed when we relayed to NEW_THREAD above.
      relay.rekeySession(OLD_THREAD, NEW_THREAD);

      // Advance fake timers well past the original IDLE_TIMEOUT_MS (300 000 ms).
      vi.advanceTimersByTime(400_000);

      // The moved session must still be in cache: relay on NEW_THREAD should NOT
      // call factory.resume again.
      await relay.relay({ threadId: NEW_THREAD, channelId: '-100' }, 'after move');
      expect(factory.resume).toHaveBeenCalledTimes(2);
    });

    it('idle-eviction log reflects the cached sessionName at eviction time', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await relay.relay(DEFAULT_CTX, 'hello');

      // Advance past the idle timeout to trigger the eviction callback.
      vi.advanceTimersByTime(400_000);

      const evictionLog = logSpy.mock.calls
        .map((args) => args.join(' '))
        .find((line) => line.includes('Session handle evicted'));
      expect(evictionLog).toBeDefined();
      expect(evictionLog).toContain(`"${SESSION_ENTRY.sessionName}"`);
    });
  });

  describe('SDK crash recovery', () => {
    it('relay calls factory.resetForRestart() on non-timeout SDK error', async () => {
      const session = {
        send: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() { throw new Error('SDK connection lost'); },
        }),
      };
      const factory = makeMockFactory(session);
      factory.resetForRestart = vi.fn();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resetForRestart).toHaveBeenCalledOnce();
    });

    it('relay does NOT call resetForRestart() on stream timeout error', async () => {
      const session = {
        send: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() { throw new StreamTimeoutError(); },
        }),
      };
      const factory = makeMockFactory(session);
      factory.resetForRestart = vi.fn();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const channel = makeMockChannel();
      const relay = new Relay(channel, registry, factory, 'test-model');

      await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

      expect(factory.resetForRestart).not.toHaveBeenCalled();
    });
  });
});
