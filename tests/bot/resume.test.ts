import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import { makeMockFactory } from '../mocks/sdk.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

type HandlerFn = (ctx: any) => Promise<void>;

function makeMockBot() {
  const commandHandlers = new Map<string, HandlerFn>();
  const onHandlers = new Map<string, HandlerFn>();

  const bot = {
    command: vi.fn((name: string, handler: HandlerFn) => {
      commandHandlers.set(name, handler);
    }),
    on: vi.fn((event: string, handler: HandlerFn) => {
      onHandlers.set(event, handler);
    }),
    catch: vi.fn(),
  };

  return { bot, commandHandlers, onHandlers };
}

/**
 * Stub registry extended with findByName, which Kat will add to ISessionRegistry.
 * The stub implements the same scanning logic as the planned implementation:
 * linear search over entries by sessionName.
 */
function makeResumeStubRegistry(entries: SessionEntry[] = []): ISessionRegistry & { findByName: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> } {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  const nameMap = new Map(entries.map((e) => [e.sessionName, e]));

  const registry = {
    register: vi.fn(async (topicId: number, chatId: number, sessionName: string, model?: string) => {
      const entry: SessionEntry = {
        sessionName,
        topicId,
        chatId,
        createdAt: new Date().toISOString(),
        ...(model !== undefined && { model }),
      };
      map.set(topicId, entry);
      nameMap.set(sessionName, entry);
    }),
    resolve: vi.fn((topicId: number) => map.get(topicId)),
    list: vi.fn(() => Array.from(map.values())),
    remove: vi.fn(async (topicId: number) => {
      const entry = map.get(topicId);
      if (entry) {
        nameMap.delete(entry.sessionName);
        map.delete(topicId);
        return true;
      }
      return false;
    }),
    load: vi.fn(),
    findByName: vi.fn((name: string) => nameMap.get(name)),
    move: vi.fn(async (fromTopicId: number, toTopicId: number, sessionName: string, chatId: number, model?: string) => {
      const old = map.get(fromTopicId);
      if (old) {
        map.delete(fromTopicId);
        nameMap.delete(sessionName);
        const newEntry: SessionEntry = {
          sessionName,
          topicId: toTopicId,
          chatId,
          createdAt: old.createdAt,
          ...(model !== undefined && { model }),
        };
        map.set(toTopicId, newEntry);
        nameMap.set(sessionName, newEntry);
      }
    }),
  } as unknown as ISessionRegistry & { findByName: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> };

  return registry;
}

function makeMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    message: { message_thread_id: 10, text: '/resume my-session' },
    match: 'my-session',
    chat: { id: -1001234567890 },
    reply: vi.fn().mockResolvedValue({
      message_id: 200,
      chat: { id: -1001234567890 },
    }),
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };
}

// ─── shared fixtures ───────────────────────────────────────────────────────────

/** A session bound to topic 99 (not the default topic 10). */
const REMOTE_ENTRY: SessionEntry = {
  sessionName: 'my-session',
  topicId: 99,
  chatId: -1001234567890,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** A different session also bound to topic 99. */
const OTHER_ENTRY: SessionEntry = {
  sessionName: 'other-session',
  topicId: 99,
  chatId: -1001234567890,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** A session already bound to topic 10 (the "current" topic in ctx). */
const LOCAL_ENTRY: SessionEntry = {
  sessionName: 'my-session',
  topicId: 10,
  chatId: -1001234567890,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// ─── tests ────────────────────────────────────────────────────────────────────

describe('/resume command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── registration ──────────────────────────────────────────────────────────

  it('registers a /resume command handler', () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();

    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    expect(commandHandlers.has('resume')).toBe(true);
  });

  // ── usage / argument validation ───────────────────────────────────────────

  it('replies with a usage hint when no session name is provided', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: '' });
    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/[Uu]sage|\/resume/),
      expect.objectContaining({ message_thread_id: 10 }),
    );
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('replies with a usage hint when match is undefined (no args)', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: undefined });
    await handler(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('rejects when used outside a forum topic (no message_thread_id)', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({
      message: { text: '/resume my-session' }, // no message_thread_id
    });
    await handler(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/forum topic|[Uu]sage|\/resume/),
    );
  });

  // ── unknown session name ───────────────────────────────────────────────────

  it('errors when session name is not found in the registry', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([]); // empty registry
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'unknown-session' });
    await handler(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('unknown-session'),
      expect.anything(),
    );
  });

  it('lists available session names in the error when session not found', async () => {
    const existing: SessionEntry = {
      sessionName: 'available-one',
      topicId: 50,
      chatId: -100,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([existing]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'no-such-session' });
    await handler(ctx);

    const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Error must tell the user HOW to find available sessions (/list hint or direct listing)
    expect(replyText).toMatch(/\/list|available|session/i);
  });

  // ── already bound here (no-op) ─────────────────────────────────────────────

  it('replies with "already bound here" when session is already linked to this topic', async () => {
    // LOCAL_ENTRY: my-session is already bound to topic 10 (the current topic)
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([LOCAL_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'my-session' }); // topicId = 10
    await handler(ctx);

    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.remove).not.toHaveBeenCalled();
    // Should reply with a friendly "already bound" message (success tone, no error)
    const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText.toLowerCase()).toMatch(/already|bound|here/);
  });

  // ── MOVE semantics: session bound to a different topic ─────────────────────

  it('moves session from old topic to current topic via atomic move()', async () => {
    // REMOTE_ENTRY: my-session is bound to topic 99; we want to move it to topic 10
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'my-session' }); // current topic = 10
    await handler(ctx);

    // Must use atomic move — not separate remove + register
    expect(registry.move).toHaveBeenCalledWith(
      99,
      10,
      'my-session',
      -1001234567890,
      undefined, // REMOTE_ENTRY has no model — carry forward as undefined
    );
    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('carries the existing model forward on move', async () => {
    const entryWithModel: SessionEntry = {
      ...REMOTE_ENTRY,
      model: 'claude-opus-4.5',
    };
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([entryWithModel]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'my-session' });
    await handler(ctx);

    expect(registry.move).toHaveBeenCalledWith(
      99,
      10,
      'my-session',
      -1001234567890,
      'claude-opus-4.5',
    );
  });

  it('confirms move with a success message mentioning the old topic ID', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'my-session' }); // moved FROM topic 99
    await handler(ctx);

    const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Success indicator (✅) and the session name must appear
    expect(replyText).toContain('my-session');
    // Old topic ID should be mentioned (user needs to know what was unbound)
    expect(replyText).toContain('99');
  });

  // ── current topic already has a DIFFERENT session ─────────────────────────

  it('rejects move when current topic is already linked to a different session', async () => {
    // topic 10 has "other-session"; we try to /resume "my-session" (bound at topic 99)
    const currentTopicEntry: SessionEntry = {
      sessionName: 'other-session',
      topicId: 10,
      chatId: -1001234567890,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([currentTopicEntry, REMOTE_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'my-session' }); // current topic 10 has other-session
    await handler(ctx);

    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
    const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText).toMatch(/already linked|\/remove/i);
    expect(replyText).toContain('other-session');
  });

  // ── persistence triggered ──────────────────────────────────────────────────

  it('triggers registry persistence on a successful move (move is called once atomically)', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry([REMOTE_ENTRY]);
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('resume')!;
    const ctx = makeMockCtx({ match: 'my-session' });
    await handler(ctx);

    // Exactly one atomic move — no separate remove/register calls
    expect(registry.move).toHaveBeenCalledTimes(1);
    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
  });

  // ── /help includes /resume ─────────────────────────────────────────────────

  it('/help text includes /resume', async () => {
    const { bot, commandHandlers } = makeMockBot();
    const registry = makeResumeStubRegistry();
    const factory = makeMockFactory();
    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    const handler = commandHandlers.get('help')!;
    const ctx = makeMockCtx();
    await handler(ctx);

    const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText).toContain('/resume');
  });
});
