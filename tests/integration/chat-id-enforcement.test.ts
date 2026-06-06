/**
 * Integration test: Chat ID enforcement middleware.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBot } from '../../src/bot/index.js';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import type { SessionEntry } from '../../src/types.js';
import type { ChannelPort, ChannelContext, CommandHandler, MessageHandler } from '../../src/channel/port.js';
import { makeMockFactory } from '../mocks/sdk.js';
import type { Update, Message } from 'grammy/types';

function makeStubRegistry(entries: SessionEntry[] = []): ISessionRegistry {
  const map = new Map(entries.map((e) => [e.threadId, e]));
  return {
    register: vi.fn(),
    resolve: vi.fn((threadId: string) => map.get(threadId)),
    findByName: vi.fn((name: string) => Array.from(map.values()).find((e) => e.sessionName === name)),
    findAllByName: vi.fn((name: string) => Array.from(map.values()).filter((e) => e.sessionName === name)),
    list: vi.fn(() => Array.from(map.values())),
    remove: vi.fn(async (threadId: string) => map.delete(threadId)),
    load: vi.fn(),
    move: vi.fn(),
  } as unknown as ISessionRegistry;
}

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-test',
  threadId: '42',
  channelId: '-1001234567890',
  createdAt: '2024-01-01T00:00:00.000Z',
};

const TEST_BOT_INFO = {
  id: 123,
  is_bot: true,
  first_name: 'TestBot',
  username: 'testbot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeBotBackedChannel(bot: ReturnType<typeof createBot>): ChannelPort {
  return {
    name: 'telegram',
    capabilities: {
      supportsMessageEdit: true,
      supportsThreadCreation: true,
      supportsInteractivePrompts: true,
      supportsStreaming: true,
      maxMessageLength: 4096,
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(async (ctx: ChannelContext, text: string) => {
      const sent = await bot.api.sendMessage(Number(ctx.channelId), text, ctx.threadId ? { message_thread_id: Number(ctx.threadId) } : undefined);
      return { id: String(sent.message_id) };
    }),
    editMessage: vi.fn().mockResolvedValue(true),
    splitMessage: vi.fn((text: string) => [text]),
    formatForTransport: vi.fn((text: string) => text),
    createThread: vi.fn(),
    onMessage: vi.fn((handler: MessageHandler) => {
      bot.on('message:text', async (ctx) => {
        const threadId = ctx.message.message_thread_id;
        await handler(
          {
            threadId: threadId !== undefined ? String(threadId) : '',
            channelId: String(ctx.chat.id),
          },
          ctx.message.text,
        );
      });
    }),
    onCommand: vi.fn((command: string, handler: CommandHandler) => {
      bot.command(command, async (ctx) => {
        const topicId = ctx.message?.message_thread_id;
        await handler(
          {
            threadId: topicId !== undefined ? String(topicId) : '',
            channelId: String(ctx.chat?.id ?? 0),
          },
          (ctx.match as string | undefined)?.trim() ?? '',
        );
      });
    }),
    promptUser: vi.fn().mockResolvedValue('approve'),
  } as unknown as ChannelPort;
}

function makeTestBot(allowedChatId: number) {
  const bot = createBot('fake-token', allowedChatId);
  bot.botInfo = TEST_BOT_INFO as any;

  const sendMessage = vi.fn(async (_chatId: number | string, text: string) => ({
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: allowedChatId, type: 'supergroup' },
    text,
  } as any));

  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: await sendMessage(payload.chat_id, payload.text),
      };
    }
    return prev(method, payload, signal);
  });

  return { bot, sendMessage, channel: makeBotBackedChannel(bot) };
}

function makeUpdate(chatId: number, text: string, topicId?: number): Update {
  const message: Message = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: chatId,
      type: 'supergroup',
    },
    text,
    ...(text.startsWith('/')
      ? {
          entities: [
            {
              type: 'bot_command',
              offset: 0,
              length: text.split(' ')[0].length,
            },
          ],
        }
      : {}),
  };

  if (topicId !== undefined) {
    (message as any).message_thread_id = topicId;
  }

  return {
    update_id: Math.floor(Math.random() * 1000000),
    message,
  } as Update;
}

describe('Integration: Chat ID enforcement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows messages from the allowed chat ID', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const { bot } = makeTestBot(ALLOWED_CHAT);

    let middlewarePassed = false;
    bot.on('message:text', async () => {
      middlewarePassed = true;
    });

    await bot.handleUpdate(makeUpdate(ALLOWED_CHAT, 'Hello from allowed chat', 42));
    expect(middlewarePassed).toBe(true);

    middlewarePassed = false;
    await bot.handleUpdate(makeUpdate(-9999999, 'Hello from wrong chat', 42));
    expect(middlewarePassed).toBe(false);
  });

  it('silently drops messages from disallowed chat IDs', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const DISALLOWED_CHAT = -9876543210;
    const { bot, channel } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();

    registerHandlers({ bot, registry, factory, globalModel: 'test-model', channel });

    await bot.handleUpdate(makeUpdate(DISALLOWED_CHAT, 'Hello from wrong chat', 42));

    expect(factory.resume).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('allows /help command from allowed chat ID', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const { bot, sendMessage, channel } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    const handlersOutput = registerHandlers({ bot, registry, factory, globalModel: 'test-model', channel });
    expect(handlersOutput).toBeDefined();

    await bot.handleUpdate(makeUpdate(ALLOWED_CHAT, '/help'));

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(factory.resume).not.toHaveBeenCalled();
  });

  it('drops /help command from disallowed chat ID', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const DISALLOWED_CHAT = -9876543210;
    const { bot, sendMessage, channel } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    registerHandlers({ bot, registry, factory, globalModel: 'test-model', channel });

    await bot.handleUpdate(makeUpdate(DISALLOWED_CHAT, '/help'));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(factory.resume).not.toHaveBeenCalled();
  });

  it('middleware is applied unconditionally when allowedChatId is provided', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const { bot, channel } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    registerHandlers({ bot, registry, factory, globalModel: 'test-model', channel });

    const disallowedChats = [-111, -222, -333];
    for (const chatId of disallowedChats) {
      await bot.handleUpdate(makeUpdate(chatId, 'test message', 42));
    }

    expect(factory.resume).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });
});
