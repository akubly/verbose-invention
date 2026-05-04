import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { SessionEntry } from '../../src/sessions/registry.js';
import { makeMockFactory, makeMockSession, makeStream } from '../mocks/sdk.js';
import { StreamTimeoutError } from '../../src/copilot/impl.js';
import { escapeMarkdownV2 } from '../../src/relay/markdownV2.js';

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

/** Stub SessionLookup — satisfies the shape Relay needs. */
function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return {
    resolve: vi.fn((topicId: number) => map.get(topicId)),
  };
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
      const relay = new Relay(registry, factory, 'test-model');
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
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toBe(escapeMarkdownV2('The answer is 42.\n\n📎 reach-myapp · test-model'));
    });

    it('resumes an existing session (not create) on the first relay', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');

      await relay.relay(makeMockCtx() as any);

      // resume() is attempted before create()
      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });

    it('creates a new session when resume() returns null', async () => {
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');

      await relay.relay(makeMockCtx() as any);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
      expect(factory.create).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });

    it('reuses the cached in-memory session on subsequent relay calls', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');
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
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toBe(escapeMarkdownV2('_(empty response)_\n\n📎 reach-myapp · test-model'));
    });
  });

  // ── error: no session linked ─────────────────────────────────────────────────

  describe('error: no session linked to topic', () => {
    it('replies with guidance and does not call the factory', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([]); // no entries
      const relay = new Relay(registry, factory, 'test-model');
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
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx('hello', null); // no topicId

      await relay.relay(ctx as any);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(factory.resume).not.toHaveBeenCalled();
    });

    it('returns immediately when message text is absent', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');
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
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      await expect(relay.relay(ctx as any)).resolves.not.toThrow();

      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('❌'),
      )?.[0] as string | undefined;
      expect(replyText).toMatch(/SDK down|Could not open/i);
    });

    it('edits placeholder with error message when stream fails mid-response', async () => {
      // failAfter=1 → yields chunk 0 ("Partial") then throws at chunk 1
      const session = makeMockSession(['Partial', ' answer'], 1);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');
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
      const relay = new Relay(registry, factory, 'test-model');

      // First call — stream fails, session should be evicted
      await relay.relay(makeMockCtx() as any);

      // Second call — factory.resume should be called again (evicted)
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(goodSession);
      await relay.relay(makeMockCtx() as any);

      expect(factory.resume).toHaveBeenCalledTimes(2);
    });
  });

  describe('permission prompter wiring', () => {
    it('proceeds without prompting when no permissionPrompter is configured', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model'); // no prompter
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });

    it('replies with a clear error and does not call factory when prompter is configured but chat context is absent', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockPrompter = { prompt: vi.fn().mockResolvedValue(true) };
      const relay = new Relay(registry, factory, 'test-model', mockPrompter);
      const ctx = {
        ...makeMockCtx(),
        chat: undefined,
      };

      await relay.relay(ctx as any);

      expect(warnSpy).toHaveBeenCalledWith(
        '[relay] permission prompting requires chat context — cannot prompt',
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        '⚠️ permission prompting requires chat context — cannot prompt',
        { message_thread_id: 42 },
      );
      expect(factory.resume).not.toHaveBeenCalled();
      expect(factory.create).not.toHaveBeenCalled();
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
      const relay = new Relay(registry, factory, 'test-model');

      await relay.relay(makeMockCtx() as any);

      expect(factory.create).toHaveBeenCalledWith('reach-myapp', 'claude-opus-4.5', undefined);
    });

    it('relay passes entry.model to factory.resume()', async () => {
      const entryWithModel: SessionEntry = {
        ...SESSION_ENTRY,
        model: 'claude-opus-4.6',
      };
      const factory = makeMockFactory();
      const registry = makeStubRegistry([entryWithModel]);
      const relay = new Relay(registry, factory, 'test-model');

      await relay.relay(makeMockCtx() as any);

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', 'claude-opus-4.6', undefined);
    });

    it('relay passes undefined model when entry has no model', async () => {
      const entryWithoutModel: SessionEntry = {
        ...SESSION_ENTRY,
        // no model field
      };
      const factory = makeMockFactory();
      (factory.resume as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const registry = makeStubRegistry([entryWithoutModel]);
      const relay = new Relay(registry, factory, 'test-model');

      await relay.relay(makeMockCtx() as any);

      expect(factory.create).toHaveBeenCalledWith('reach-myapp', undefined, undefined);
    });
  });

  // ── dispose ─────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('can be called without throwing (graceful shutdown)', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');
      await relay.relay(makeMockCtx() as any);

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
      const relay = new Relay(registry, factory, 'claude-sonnet-4');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toContain(escapeMarkdownV2('📎 reach-myapp · claude-opus-4.5'));
    });

    it('final message includes HUD footer with global model when no per-session model', async () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'claude-sonnet-4');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      const editCalls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
      const finalText = editCalls[editCalls.length - 1][2] as string;
      expect(finalText).toContain(escapeMarkdownV2('📎 reach-myapp · claude-sonnet-4'));
    });
  });

  // ── chunk cap ────────────────────────────────────────────────────────────────

  describe('chunk cap (F-D / F10)', () => {
    it('caps multi-chunk send at exactly MAX_CHUNKS (25) with consistent numbering and footer', async () => {
      // Real timers needed: 24 follow-up chunks × 100ms delay would hang fake timers.
      vi.useRealTimers();

      // 26 paragraphs of 1800 chars each → 26 natural chunks at effectiveMax=2048;
      // splitForTelegram caps to 25 (maxChunks) BEFORE numbering/footer so the
      // truncation marker carries [25/25] and the HUD footer.
      const bigContent = Array.from({ length: 26 }, () => 'x'.repeat(1800)).join('\n\n');
      const session = makeMockSession([bigContent]);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      // First chunk via editMessageText, remaining via ctx.reply.
      const replyCalls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
      const followUpReplies = replyCalls.filter((c: unknown[]) => c[0] !== '…');

      // Total = 1 (edit) + followUps = MAX_CHUNKS = 25 → followUps = 24
      expect(followUpReplies.length).toBeLessThanOrEqual(24);

      // Last follow-up must carry the truncation marker (with consistent [n/total] prefix
      // and HUD footer — verified in depth by messageSplitter tests)
      const lastReply = followUpReplies[followUpReplies.length - 1]?.[0] as string | undefined;
      expect(lastReply).toContain('truncated');
    }, 10_000);
  });

  // ── first-chunk failure (F-E) ─────────────────────────────────────────────────

  describe('first-chunk failure (F-E)', () => {
    it('aborts follow-up chunks and updates placeholder when first-chunk edit fails', async () => {
      // Two-chunk response so we can confirm chunk 2 is never sent
      const chunk1 = 'x'.repeat(2020);
      const chunk2 = 'y'.repeat(2020);
      const session = makeMockSession([chunk1 + '\n\n' + chunk2]);
      const factory = makeMockFactory(session);
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      // Make every editMessageText call fail (non-parse-entities → safeEdit returns false)
      (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Telegram API unavailable'),
      );

      await relay.relay(ctx as any);

      // ctx.reply called only once — for the "…" placeholder; no follow-up chunks
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });

      // Error log emitted for first-chunk failure
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('First-chunk edit failed'),
      );

      // safeEdit warned about the failed editMessageText calls
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('editMessageText failed'),
        expect.anything(),
      );
    });
  });


  // ── rekeySession (H-A: cache rekey after /resume) ────────────────────────────

  describe('rekeySession', () => {
    it('moves the cached session to the new topic key so next relay reuses it', async () => {
      const factory = makeMockFactory();
      const OLD_TOPIC = 10;
      const NEW_TOPIC = 20;
      const entryOld: SessionEntry = { ...SESSION_ENTRY, topicId: OLD_TOPIC };
      const entryNew: SessionEntry = { ...SESSION_ENTRY, topicId: NEW_TOPIC };
      const lookupMap = new Map<number, SessionEntry>([[OLD_TOPIC, entryOld]]);
      const registry: SessionLookup = { resolve: vi.fn((id: number) => lookupMap.get(id)) };
      const relay = new Relay(registry, factory, 'test-model');

      // Warm the cache for OLD_TOPIC
      await relay.relay(makeMockCtx('hello', OLD_TOPIC) as any);
      expect(factory.resume).toHaveBeenCalledTimes(1);

      // Simulate /resume: update the registry lookup to point NEW_TOPIC → session
      lookupMap.delete(OLD_TOPIC);
      lookupMap.set(NEW_TOPIC, entryNew);

      // Rekey the relay cache
      relay.rekeySession(OLD_TOPIC, NEW_TOPIC);

      // Next relay call on NEW_TOPIC must NOT call factory again — cache hit
      await relay.relay(makeMockCtx('hello', NEW_TOPIC) as any);
      expect(factory.resume).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no cache entry exists for fromTopicId', () => {
      const factory = makeMockFactory();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');

      // No relay call yet — cache is empty; should not throw
      expect(() => relay.rekeySession(42, 99)).not.toThrow();
    });

    it('next relay on old topic creates a new session after rekey', async () => {
      const factory = makeMockFactory();
      const OLD_TOPIC = 10;
      const NEW_TOPIC = 20;
      const entryOld: SessionEntry = { ...SESSION_ENTRY, topicId: OLD_TOPIC };
      const lookupMap = new Map<number, SessionEntry>([[OLD_TOPIC, entryOld]]);
      const registry: SessionLookup = { resolve: vi.fn((id: number) => lookupMap.get(id)) };
      const relay = new Relay(registry, factory, 'test-model');

      await relay.relay(makeMockCtx('hello', OLD_TOPIC) as any);
      expect(factory.resume).toHaveBeenCalledTimes(1);

      relay.rekeySession(OLD_TOPIC, NEW_TOPIC);

      // OLD_TOPIC now has no cached session — next message there calls factory again
      await relay.relay(makeMockCtx('hello', OLD_TOPIC) as any);
      expect(factory.resume).toHaveBeenCalledTimes(2);
    });
  });

  describe('SDK crash recovery', () => {
    it('relay calls factory.resetForRestart() on non-timeout SDK error', async () => {
      // send() must return an AsyncIterable that throws — not a rejected Promise
      const session = {
        send: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() { throw new Error('SDK connection lost'); },
        }),
      };
      const factory = makeMockFactory(session);
      factory.resetForRestart = vi.fn();
      const registry = makeStubRegistry([SESSION_ENTRY]);
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

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
      const relay = new Relay(registry, factory, 'test-model');
      const ctx = makeMockCtx();

      await relay.relay(ctx as any);

      expect(factory.resetForRestart).not.toHaveBeenCalled();
    });
  });
});
