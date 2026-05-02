/**
 * Integration test: Chat ID enforcement middleware.
 *
 * Tests that the chat ID guard middleware in createBot() correctly
 * filters messages based on allowed chat ID.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBot } from '../../src/bot/index.js';
import { registerHandlers } from '../../src/bot/handlers.js';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import type { SessionEntry } from '../../src/types.js';
import { makeMockFactory } from '../mocks/sdk.js';
import type { Update, Message } from 'grammy/types';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal stub registry for integration test. */
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

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-test',
  topicId: 42,
  chatId: -1001234567890,
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

  return { bot, sendMessage };
}

/**
 * Creates a realistic Telegram Update object for testing.
 * grammY's bot.handleUpdate() processes these to trigger handlers.
 */
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

// ─── tests ────────────────────────────────────────────────────────────────────

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
    const { bot } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const factory = makeMockFactory();

    registerHandlers({ bot, registry, factory, globalModel: 'test-model' });

    const update = makeUpdate(DISALLOWED_CHAT, 'Hello from wrong chat', 42);
    
    // Process the update — should be silently dropped by middleware
    await bot.handleUpdate(update);

    // Verify relay was NOT triggered (factory should not be called)
    expect(factory.resume).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('allows /help command from allowed chat ID', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const { bot, sendMessage } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    const handlersOutput = registerHandlers({ bot, registry, factory, globalModel: 'test-model' });
    expect(handlersOutput).toBeDefined(); // relay instance

    const update = makeUpdate(ALLOWED_CHAT, '/help');
    await bot.handleUpdate(update);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(factory.resume).not.toHaveBeenCalled(); // /help doesn't trigger relay
  });

  it('drops /help command from disallowed chat ID', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const DISALLOWED_CHAT = -9876543210;
    const { bot, sendMessage } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    registerHandlers({ bot, registry, factory, globalModel: 'test-model' });

    const update = makeUpdate(DISALLOWED_CHAT, '/help');
    await bot.handleUpdate(update);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(factory.resume).not.toHaveBeenCalled();
  });

  it('middleware is applied unconditionally when allowedChatId is provided', async () => {
    const ALLOWED_CHAT = -1001234567890;
    const { bot } = makeTestBot(ALLOWED_CHAT);

    const registry = makeStubRegistry();
    const factory = makeMockFactory();

    registerHandlers({ bot, registry, factory, globalModel: 'test-model' });

    // Test multiple different disallowed chat IDs
    const disallowedChats = [-111, -222, -333];
    for (const chatId of disallowedChats) {
      const update = makeUpdate(chatId, 'test message', 42);
      await bot.handleUpdate(update);
    }

    // None of the disallowed messages triggered relay
    expect(factory.resume).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });
});
