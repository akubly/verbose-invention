/**
 * Shared mock factories for grammY bot and context objects.
 * Used by tests that call registerHandlers() and need a minimal
 * grammY-compatible bot double.
 *
 * Extracted from (and reconciled across):
 *   - tests/bot/handlers.slashGuard.test.ts
 *   - tests/bot/cwdCommand.test.ts
 *   - tests/bot/newCwdFlag.test.ts
 *
 * NOTE: AfkModeController takes a different bot shape (bot.api.*).
 * tests/relay/afkMode.slashGuard.test.ts keeps its own local makeMockBot.
 */

import { vi } from 'vitest';

type HandlerFn = (ctx: any) => Promise<void>;

/**
 * Builds a minimal grammY Bot double for registerHandlers() tests.
 * Returns the bot stub plus handler maps so tests can invoke registered
 * command and on() handlers by name.
 */
export function makeMockBot() {
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
 * Builds a minimal grammY Context double for message:text handler tests.
 * reply resolves with a message stub (message_id + chat.id) so tests that
 * assert on the placeholder reply work correctly.
 */
export function makeMockCtx(text: string, topicId = 42) {
  return {
    message: { message_thread_id: topicId, text },
    chat: { id: -1001234567890 },
    reply: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: -1001234567890 } }),
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}
