import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { SessionEntry } from '../../src/types.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

type HandlerFn = (ctx: any) => Promise<void>;

/** Captures handlers registered via bot.command() and bot.on(). */
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

/** Stub ISessionRegistry — mirrors the pattern from relay tests. */
function makeStubRegistry(entries: SessionEntry[] = []): ISessionRegistry {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return {
    register: vi.fn(),
    resolve: vi.fn((topicId: number) => map.get(topicId)),
    list: vi.fn(() => Array.from(map.values())),
    remove: vi.fn(async (topicId: number) => map.delete(topicId)),
    load: vi.fn(),
  } as unknown as ISessionRegistry;
}

const ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  topicId: 42,
  chatId: -1001234567890,
  createdAt: '2024-01-01T00:00:00.000Z',
};

/** Builds a mock grammY Context for command/message handler tests. */
function makeMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    message: { message_thread_id: 42, text: '/new my-session' },
    match: 'my-session',
    chat: { id: -1001234567890 },
    reply: vi.fn().mockResolvedValue({
      message_id: 100,
      chat: { id: -1001234567890 },
    }),
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('registerHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers /new, /list, /remove, /help commands and message:text handler', () => {
    const { bot, commandHandlers, onHandlers } = makeMockBot();
    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

    expect(commandHandlers.has('new')).toBe(true);
    expect(commandHandlers.has('list')).toBe(true);
    expect(commandHandlers.has('remove')).toBe(true);
    expect(commandHandlers.has('help')).toBe(true);
    expect(onHandlers.has('message:text')).toBe(true);
    expect(bot.catch).toHaveBeenCalled();
  });

  // ── /new command ──────────────────────────────────────────────────────────

  describe('/new command', () => {
    it('registers a session and replies with confirmation', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(registry.register).toHaveBeenCalledWith(42, -1001234567890, 'my-session', undefined);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('my-session'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it('rejects when not inside a forum topic', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({
        message: { text: '/new test' }, // no message_thread_id
      });
      await handler(ctx);

      expect(registry.register).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('forum topic'));
    });

    it('rejects when no session name is provided', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: '' });
      await handler(ctx);

      expect(registry.register).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it('rejects when match is undefined (no args at all)', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: undefined });
      await handler(ctx);

      expect(registry.register).not.toHaveBeenCalled();
    });

    it('rejects when topic already has a session linked', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(registry.register).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('already linked'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it('replies with error when registry.register() throws', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      (registry.register as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Disk full'),
      );
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Disk full'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it('rejects session names with invalid characters', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;

      for (const bad of ['My-Session', 'has spaces', 'back`tick', '-leading', 'under_score']) {
        const ctx = makeMockCtx({ match: bad });
        await handler(ctx);

        expect(registry.register).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith(
          expect.stringContaining('Invalid session name'),
          expect.objectContaining({ message_thread_id: 42 }),
        );
      }
    });

    it('trims whitespace from session name', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: '  spaced-name  ' });
      await handler(ctx);

      expect(registry.register).toHaveBeenCalledWith(42, -1001234567890, 'spaced-name', undefined);
    });
  });

  // ── /list command ─────────────────────────────────────────────────────────

  describe('/list command', () => {
    it('reports no sessions when registry is empty', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry([]);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('list')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No sessions'));
    });

    it('lists all registered sessions with names and topic IDs', async () => {
      const entries: SessionEntry[] = [
        { sessionName: 'alpha', topicId: 1, chatId: -100, createdAt: '2024-01-01T00:00:00Z' },
        { sessionName: 'beta', topicId: 2, chatId: -100, createdAt: '2024-01-01T00:00:00Z' },
      ];
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry(entries);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('list')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain('alpha');
      expect(replyText).toContain('beta');
      expect(replyText).toContain('#1');
      expect(replyText).toContain('#2');
    });
  });

  // ── /remove command ───────────────────────────────────────────────────────

  describe('/remove command', () => {
    it('removes the session and confirms', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('remove')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(registry.remove).toHaveBeenCalledWith(42);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('unlinked'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it('rejects when not inside a forum topic', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('remove')!;
      const ctx = makeMockCtx({
        message: { text: '/remove' }, // no message_thread_id
      });
      await handler(ctx);

      expect(registry.remove).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('forum topic'));
    });

    it('replies with warning when no session is linked to topic', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry(); // empty — remove returns false
      (registry.remove as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('remove')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('No session'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });
  });

  // ── catch-all relay handler ───────────────────────────────────────────────

  describe('catch-all relay (message:text)', () => {
    it('ignores non-topic messages (no message_thread_id)', async () => {
      const { bot, onHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = onHandlers.get('message:text')!;
      const ctx = makeMockCtx({
        message: { text: 'hello' }, // no message_thread_id
      });
      await handler(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('ignores command messages (starting with /)', async () => {
      const { bot, onHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = onHandlers.get('message:text')!;
      const ctx = makeMockCtx({
        message: { message_thread_id: 42, text: '/unknown-cmd' },
      });
      await handler(ctx);

      // reply is not called for relaying (no placeholder)
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('relays text messages in a topic with a linked session', async () => {
      const session = makeMockSession(['Response from Copilot']);
      const { bot, onHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory(session);
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = onHandlers.get('message:text')!;
      const ctx = makeMockCtx({
        message: { message_thread_id: 42, text: 'Build the parser' },
      });
      await handler(ctx);

      // Relay sends a placeholder "…" reply
      expect(ctx.reply).toHaveBeenCalledWith('…', { message_thread_id: 42 });
      // Then edits with the response
      expect(ctx.api.editMessageText).toHaveBeenCalled();
    });

    it('replies with guidance when topic has no linked session', async () => {
      const { bot, onHandlers } = makeMockBot();
      const registry = makeStubRegistry(); // no entries
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = onHandlers.get('message:text')!;
      const ctx = makeMockCtx({
        message: { message_thread_id: 99, text: 'hello' },
      });
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('/new'),
        expect.objectContaining({ message_thread_id: 99 }),
      );
    });
  });

  // ── /new command with --model flag ───────────────────────────────────────

  describe('/new command with --model flag', () => {
    it('/new name --model claude-opus-4.5 registers with model', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: 'my-session --model claude-opus-4.5' });
      await handler(ctx);

      expect(registry.register).toHaveBeenCalledWith(
        42,
        -1001234567890,
        'my-session',
        'claude-opus-4.5',
      );
    });

    it('/new name registers without model (backward compat)', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: 'my-session' });
      await handler(ctx);

      expect(registry.register).toHaveBeenCalledWith(
        42,
        -1001234567890,
        'my-session',
        undefined,
      );
    });

    it('/new name --model (no value) shows error', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: 'my-session --model' });
      await handler(ctx);

      expect(registry.register).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('model value'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it('/new name --model with spaces in model name', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('new')!;
      const ctx = makeMockCtx({ match: 'my-session --model claude-opus-4.5' });
      await handler(ctx);

      expect(registry.register).toHaveBeenCalledWith(
        42,
        -1001234567890,
        'my-session',
        'claude-opus-4.5',
      );
    });
  });

  // ── /list command with model display ─────────────────────────────────────

  describe('/list command with model display', () => {
    it('/list shows model when set', async () => {
      const entries: SessionEntry[] = [
        {
          sessionName: 'with-model',
          topicId: 1,
          chatId: -100,
          createdAt: '2024-01-01T00:00:00Z',
          model: 'claude-opus-4.5',
        },
        {
          sessionName: 'no-model',
          topicId: 2,
          chatId: -100,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry(entries);
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('list')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain('with-model');
      expect(replyText).toContain('claude-opus-4.5');
      expect(replyText).toContain('no-model');
    });
  });

  // ── /help includes --model flag ──────────────────────────────────────────

  describe('/help includes --model flag', () => {
    it('/help includes --model flag documentation', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('help')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain('--model');
    });
  });

  // ── /help command ─────────────────────────────────────────────────────────

  describe('/help command', () => {
    it('replies with help message containing available commands', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('help')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain('/new');
      expect(replyText).toContain('/list');
      expect(replyText).toContain('/remove');
      expect(replyText).toContain('/pair');
      expect(replyText).toContain('/help');
    });

    it('works without a forum topic (general chat)', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('help')!;
      const ctx = makeMockCtx({
        message: { text: '/help' }, // no message_thread_id
      });
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain('/new');
    });

    it('/help text includes /pair command', async () => {
      const { bot, commandHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model' });

      const handler = commandHandlers.get('help')!;
      const ctx = makeMockCtx();
      await handler(ctx);

      const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(replyText).toContain('/pair');
    });
  });
});

