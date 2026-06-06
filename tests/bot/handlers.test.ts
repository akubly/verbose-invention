import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerHandlers } from '../../src/bot/handlers.js';
import { disposePromptRegistry } from '../../src/bot/prompt.js';
import type { SessionEntry } from '../../src/types.js';
import type { ChannelPort, ChannelContext, CommandHandler } from '../../src/channel/port.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';
import { makeStubRegistry } from '../helpers/registryMocks.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

type HandlerFn = (ctx: any) => Promise<void>;

/** Captures handlers registered via channel.onCommand() and channel.onMessage(). */
function makeMockChannel(): ChannelPort {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: '100' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    splitMessage: vi.fn((text: string) => [text]),
    formatForTransport: vi.fn((text: string) => text),
    createThread: vi.fn().mockResolvedValue({ id: 'thread-1' }),
    onMessage: vi.fn(),
    onCommand: vi.fn(),
    promptUser: vi.fn().mockResolvedValue(true),
    capabilities: {
      supportsMessageEdit: true,
      supportsThreadCreation: true,
      supportsInteractivePrompts: true,
      supportsStreaming: true,
      maxMessageLength: 4096,
    },
  } as unknown as ChannelPort;
}

/** Extracts the CommandHandler registered for a given command via channel.onCommand(). */
function getChannelHandler(channel: ChannelPort, command: string): CommandHandler | undefined {
  const calls = (channel.onCommand as ReturnType<typeof vi.fn>).mock.calls as [string, CommandHandler][];
  return calls.find(([cmd]) => cmd === command)?.[1];
}

/** Extracts the MessageHandler registered via channel.onMessage(). */
function getMessageHandler(channel: ChannelPort) {
  const calls = (channel.onMessage as ReturnType<typeof vi.fn>).mock.calls as [(...args: any[]) => Promise<void>][];
  return calls[0]?.[0];
}

/** Builds a minimal grammY Bot double — still needed for ensurePromptRegistry tests. */
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

const ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  threadId: '42',
  channelId: '-1001234567890',
  createdAt: '2024-01-01T00:00:00.000Z',
};

/** Channel context matching ENTRY's thread/channel. */
const CHANNEL_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };

/** Channel context for a command sent in General Topic (no thread). */
const NO_TOPIC_CTX: ChannelContext = { threadId: '', channelId: '-1001234567890' };

// ─── tests ────────────────────────────────────────────────────────────────────

describe('registerHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers /new, /list, /remove, /help commands and message handler via channel', () => {
    const { bot } = makeMockBot();
    const registry = makeStubRegistry();
    const factory = makeMockFactory();
    const channel = makeMockChannel();

    registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

    const registeredCommands = (channel.onCommand as ReturnType<typeof vi.fn>).mock.calls.map(([cmd]: [string]) => cmd);
    expect(registeredCommands).toContain('new');
    expect(registeredCommands).toContain('list');
    expect(registeredCommands).toContain('remove');
    expect(registeredCommands).toContain('resume');
    expect(registeredCommands).toContain('help');
    expect(channel.onMessage).toHaveBeenCalled();
  });

  describe('/new command', () => {
    it('registers a session and replies with confirmation', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session');

      expect(registry.register).toHaveBeenCalledWith('42', '-1001234567890', 'my-session', undefined);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('my-session'),
      );
    });

    it('rejects when not inside a forum topic', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(NO_TOPIC_CTX, 'test');

      expect(registry.register).not.toHaveBeenCalled();
      expect(channel.sendMessage).toHaveBeenCalledWith(NO_TOPIC_CTX, expect.stringContaining('forum topic'));
    });

    it('rejects when no session name is provided', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, '');

      expect(registry.register).not.toHaveBeenCalled();
      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('Usage'),
      );
    });

    it('rejects when match is undefined (no args at all)', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, '');

      expect(registry.register).not.toHaveBeenCalled();
    });

    it('rejects when topic already has a session linked', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session');

      expect(registry.register).not.toHaveBeenCalled();
      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('already linked'),
      );
    });

    it('replies with error when registry.register() throws', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      (registry.register as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Disk full'),
      );
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('Disk full'),
      );
    });

    it('rejects session names with invalid characters', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;

      for (const bad of ['My-Session', 'back`tick', '-leading', 'under_score']) {
        vi.clearAllMocks();
        (channel.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '100' });
        await handler(CHANNEL_CTX, bad);

        expect(registry.register).not.toHaveBeenCalled();
        expect(channel.sendMessage).toHaveBeenCalledWith(
          CHANNEL_CTX,
          expect.stringContaining('Invalid session name'),
        );
      }
    });

    it('trims whitespace from session name', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, '  spaced-name  ');

      expect(registry.register).toHaveBeenCalledWith('42', '-1001234567890', 'spaced-name', undefined);
    });
  });

  describe('/list command', () => {
    it('reports no sessions when registry is empty', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([]);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'list')!;
      await handler(CHANNEL_CTX, '');

      expect(channel.sendMessage).toHaveBeenCalledWith(CHANNEL_CTX, expect.stringContaining('No sessions'));
    });

    it('lists all registered sessions with names and topic IDs', async () => {
      const entries: SessionEntry[] = [
        { sessionName: 'alpha', threadId: '1', channelId: '-100', createdAt: '2024-01-01T00:00:00Z' },
        { sessionName: 'beta', threadId: '2', channelId: '-100', createdAt: '2024-01-01T00:00:00Z' },
      ];
      const { bot } = makeMockBot();
      const registry = makeStubRegistry(entries);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'list')!;
      await handler(CHANNEL_CTX, '');

      const sendArgs = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [ChannelContext, string];
      const replyText = sendArgs[1];
      expect(replyText).toContain('alpha');
      expect(replyText).toContain('beta');
      expect(replyText).toContain('#1');
      expect(replyText).toContain('#2');
    });
  });

  describe('/remove command', () => {
    it('removes the session and confirms', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'remove')!;
      await handler(CHANNEL_CTX, '');

      expect(registry.remove).toHaveBeenCalledWith('42');
      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('unlinked'),
      );
    });

    it('rejects when not inside a forum topic', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'remove')!;
      await handler(NO_TOPIC_CTX, '');

      expect(registry.remove).not.toHaveBeenCalled();
      expect(channel.sendMessage).toHaveBeenCalledWith(NO_TOPIC_CTX, expect.stringContaining('forum topic'));
    });

    it('replies with warning when no session is linked to topic', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      (registry.remove as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'remove')!;
      await handler(CHANNEL_CTX, '');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('No session'),
      );
    });
  });

  describe('catch-all relay (channel.onMessage)', () => {
    it('ignores non-topic messages (empty threadId)', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getMessageHandler(channel)!;
      await handler({ threadId: '', channelId: '-1001234567890' }, 'hello');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores Telegram bot commands like /list (handled by channel.onCommand)', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getMessageHandler(channel)!;
      await handler(CHANNEL_CTX, '/list');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('relays text messages in a topic with a linked session', async () => {
      const session = makeMockSession(['Response from Copilot']);
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory(session);
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getMessageHandler(channel)!;
      await handler(CHANNEL_CTX, 'Build the parser');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: '42' }),
        '…',
      );
      expect(channel.editMessage).toHaveBeenCalled();
    });

    it('passes the interactive permission policy through to Relay', async () => {
      const session = makeMockSession(['Response from Copilot']);
      const { bot } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory(session);
      const channel = makeMockChannel();
      registerHandlers({
        bot: bot as any,
        registry,
        factory,
        globalModel: 'test-model',
        channel,
        permissionPolicy: 'interactiveDestructive',
      });

      const handler = getMessageHandler(channel)!;
      await handler(CHANNEL_CTX, 'Build the parser');

      expect(factory.resume).toHaveBeenCalledWith('reach-myapp', undefined, expect.any(Function));
    });

    it('replies with guidance when topic has no linked session', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getMessageHandler(channel)!;
      await handler({ threadId: '99', channelId: '-1001234567890' }, 'hello');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining('/new'),
      );
    });
  });

  describe('/new command with --model flag', () => {
    it('/new name --model claude-opus-4.5 registers with model', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session --model claude-opus-4.5');

      expect(registry.register).toHaveBeenCalledWith(
        '42',
        '-1001234567890',
        'my-session',
        'claude-opus-4.5',
      );
    });

    it('/new name registers without model (backward compat)', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session');

      expect(registry.register).toHaveBeenCalledWith(
        '42',
        '-1001234567890',
        'my-session',
        undefined,
      );
    });

    it('/new name --model (no value) shows error', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session --model');

      expect(registry.register).not.toHaveBeenCalled();
      expect(channel.sendMessage).toHaveBeenCalledWith(
        CHANNEL_CTX,
        expect.stringContaining('model value'),
      );
    });

    it('/new name --model with hyphens in model name', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'new')!;
      await handler(CHANNEL_CTX, 'my-session --model claude-opus-4.5');

      expect(registry.register).toHaveBeenCalledWith(
        '42',
        '-1001234567890',
        'my-session',
        'claude-opus-4.5',
      );
    });
  });

  describe('/list command with model display', () => {
    it('/list shows model when set', async () => {
      const entries: SessionEntry[] = [
        {
          sessionName: 'with-model',
          threadId: '1',
          channelId: '-100',
          createdAt: '2024-01-01T00:00:00Z',
          model: 'claude-opus-4.5',
        },
        {
          sessionName: 'no-model',
          threadId: '2',
          channelId: '-100',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
      const { bot } = makeMockBot();
      const registry = makeStubRegistry(entries);
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'list')!;
      await handler(CHANNEL_CTX, '');

      const sendArgs = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [ChannelContext, string];
      const replyText = sendArgs[1];
      expect(replyText).toContain('with-model');
      expect(replyText).toContain('claude-opus-4.5');
      expect(replyText).toContain('no-model');
    });
  });

  describe('/help includes --model flag', () => {
    it('/help includes --model flag documentation', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'help')!;
      await handler(CHANNEL_CTX, '');

      const sendArgs = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [ChannelContext, string];
      expect(sendArgs[1]).toContain('--model');
    });
  });

  describe('eager callback_query:data listener for interactiveDestructive', () => {
    it('installs the callback_query:data listener during registerHandlers, before any prompt is invoked', () => {
      const { bot, onHandlers } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();

      registerHandlers({
        bot: bot as any,
        registry,
        factory,
        globalModel: 'test-model',
        channel: makeMockChannel(),
        permissionPolicy: 'interactiveDestructive',
      });

      expect(bot.on).toHaveBeenCalledWith('callback_query:data', expect.any(Function));
      expect(onHandlers.has('callback_query:data')).toBe(true);

      disposePromptRegistry(bot as any);
    });

    it('does NOT install callback_query:data listener when permissionPolicy is not interactiveDestructive', () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();

      registerHandlers({
        bot: bot as any,
        registry,
        factory,
        globalModel: 'test-model',
        channel: makeMockChannel(),
      });

      const callbackQueryCalls = (bot.on as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]: [string]) => event === 'callback_query:data',
      );
      expect(callbackQueryCalls).toHaveLength(0);
    });

    it('does not call bot.on(callback_query:data) again when promptUserForPermission runs later', async () => {
      const { bot, onHandlers } = makeMockBot();
      const registry = makeStubRegistry([ENTRY]);
      const factory = makeMockFactory(makeMockSession(['ok']));
      const channel = makeMockChannel();

      registerHandlers({
        bot: bot as any,
        registry,
        factory,
        globalModel: 'test-model',
        channel,
        permissionPolicy: 'interactiveDestructive',
      });

      const callbackQueryCallsAtSetup = (bot.on as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]: [string]) => event === 'callback_query:data',
      ).length;
      expect(callbackQueryCallsAtSetup).toBe(1);

      const callbackHandler = onHandlers.get('callback_query:data')!;
      const fakeCtx = {
        callbackQuery: { data: 'perm:approve:no-such-id', message: undefined },
        chat: undefined,
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
      };
      await callbackHandler(fakeCtx);

      const callbackQueryCallsAfterPrompt = (bot.on as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]: [string]) => event === 'callback_query:data',
      ).length;
      expect(callbackQueryCallsAfterPrompt).toBe(1);

      disposePromptRegistry(bot as any);
    });
  });

  describe('/help command', () => {
    it('replies with help message containing available commands', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'help')!;
      await handler(CHANNEL_CTX, '');

      expect(channel.sendMessage).toHaveBeenCalledOnce();
      const sendArgs = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [ChannelContext, string];
      const replyText = sendArgs[1];
      expect(replyText).toContain('/new');
      expect(replyText).toContain('/list');
      expect(replyText).toContain('/remove');
      expect(replyText).toContain('/pair');
      expect(replyText).toContain('/help');
    });

    it('works without a forum topic (general chat)', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'help')!;
      await handler(NO_TOPIC_CTX, '');

      expect(channel.sendMessage).toHaveBeenCalled();
      const sendArgs = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [ChannelContext, string];
      expect(sendArgs[1]).toContain('/new');
    });

    it('/help text includes /pair command', async () => {
      const { bot } = makeMockBot();
      const registry = makeStubRegistry();
      const factory = makeMockFactory();
      const channel = makeMockChannel();
      registerHandlers({ bot: bot as any, registry, factory, globalModel: 'test-model', channel });

      const handler = getChannelHandler(channel, 'help')!;
      await handler(CHANNEL_CTX, '');

      const sendArgs = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [ChannelContext, string];
      expect(sendArgs[1]).toContain('/pair');
    });
  });
});
