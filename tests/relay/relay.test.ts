import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import type { SessionRegistry, SessionEntry } from '../../src/sessions/registry.js';
import { makeMockFactory, makeMockSession, makeStream } from '../mocks/sdk.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal grammY Context double for relay tests. */
function makeMockCtx(
  text = 'Hello Copilot',
  topicId: number | undefined | null = 42,
  chatId = -1001234567890,
) {
  return {
    message: (topicId !== undefined && topicId !== null)
      ? { message_thread_id: topicId, text }
      : { text },
    chat: { id: chatId },
    reply: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: chatId } }),
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

/** Stub SessionRegistry — satisfies the shape Relay needs. */
function makeStubRegistry(entries: SessionEntry[] = []): SessionRegistry {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return {
    register: vi.fn(),
    resolve: vi.fn((topicId: number) => map.get(topicId)),
    list: vi.fn(() => Array.from(map.values())),
    remove: vi.fn(),
    load: vi.fn(),
  } as unknown as SessionRegistry;
}

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  topicId: 42,
  chatId: -1001234567890,
  createdAt: '2024-01-01T00:00:00.000Z',
};

// ─── tests ────────────────────────────────────────────────────────────────────

describe('Relay', () => {
  beforeEach(() => {
    // Freeze Date.now() so the 800ms throttle never fires during tests,
    // meaning only the final edit fires (easier to assert).
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
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      // Placeholder reply was sent first
      expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });

      // Final edit contains the assembled chunks from the default mock
      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      expect(editCalls.length).toBeGreaterThan(0);
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toContain('Hello world');
    });

    it('assembles all stream chunks into one final message', async () => {
      const chunks = ['The answer ', 'is ', '42.'];
      const session = makeMockSession(chunks);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toBe('The answer is 42.');
    });

    it('resumes an existing session (not create) on the first relay', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);

      await relay.relay(makeMockCtx() as any);

      // resume() is attempted before create()
      expect(factory.resume).toHaveBeenCalledWith('reach-myapp');
    });

    it('creates a new session when resume() returns null', async () => {
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);

      await relay.relay(makeMockCtx() as any);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp');
      expect(factory.create).toHaveBeenCalledWith('reach-myapp');
    });

    it('reuses the cached in-memory session on subsequent relay calls', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);
      await relay.relay(ctx as any);

      // factory.resume called only once — second call uses cached session
      expect(factory.resume).toHaveBeenCalledTimes(1);
    });

    it('handles an empty response (zero chunks) gracefully', async () => {
      const session = makeMockSession([]);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toBe('_(empty response)_');
    });
  });

  // ── error: no session linked ─────────────────────────────────────────────────

  describe('error: no session linked to topic', () => {
    it('replies with guidance and does not call the factory', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([]); // no entries
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx('hello', 42);

      await relay.relay(ctx as any);

      expect(factory.resume).not.toHaveBeenCalled();
      expect(factory.create).not.toHaveBeenCalled();
      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toMatch(/no session|link/i);
    });

    it('returns immediately when message has no topic id (non-topic message)', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry();
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx('hello', null); // no topicId

      await relay.relay(ctx as any);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(factory.resume).not.toHaveBeenCalled();
    });

    it('returns immediately when message text is absent', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      const ctx = {
        message: { message_thread_id: 42 }, // no text
        chat: { id: -100 },
        reply: vi.fn(),
        api: { editMessageText: vi.fn() },
      };

      await relay.relay(ctx as any);

      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // ── error: factory failure ───────────────────────────────────────────────────

  describe('error: factory / SDK failure', () => {
    it('replies with error message when factory.resume() throws', async () => {
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SDK down'));
      (factory.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SDK down'));
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx();

      await expect(relay.relay(ctx as any)).resolves.not.toThrow();

      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('❌'),
      )?.[0] as string | undefined;
      expect(replyText).toMatch(/SDK down|Could not open/i);
    });

    it('edits placeholder with error message when stream fails mid-response', async () => {
      // failAfter=1 → yields one chunk then throws
      const session = makeMockSession(['Partial answer'], 0);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      const ctx = makeMockCtx();

      await expect(relay.relay(ctx as any)).resolves.not.toThrow();

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const texts = editCalls.map((c: unknown[]) => c[2] as string);
      expect(texts.some((t) => t.includes('❌'))).toBe(true);
    });

    it('evicts the cached session after a stream error', async () => {
      const session = makeMockSession(['chunk'], 0);
      const goodSession = makeMockSession(['Good response']);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);

      // First call — stream fails, session should be evicted
      await relay.relay(makeMockCtx() as any);

      // Second call — factory.resume should be called again (evicted)
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(goodSession);
      await relay.relay(makeMockCtx() as any);

      expect(factory.resume).toHaveBeenCalledTimes(2);
    });
  });

  // ── dispose ─────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('can be called without throwing (graceful shutdown)', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory);
      await relay.relay(makeMockCtx() as any);

      expect(() => relay.dispose()).not.toThrow();
    });
  });
});
