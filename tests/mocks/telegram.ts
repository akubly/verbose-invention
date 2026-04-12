import { vi } from 'vitest';
import type { Transformer } from 'grammy';

export interface CapturedApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/**
 * Builds a grammY API transformer that intercepts all outbound calls.
 * Attach with `bot.api.config.use(transformer)` before `handleUpdate`.
 *
 * `sendMessage` returns a realistic Message object so that ctx.reply()
 * callers get a usable result (e.g. { message_id, chat.id }).
 */
export function makeApiInterceptor(chatId = -1001234567890) {
  const calls: CapturedApiCall[] = [];

  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });

    if (method === 'sendMessage') {
      return {
        ok: true as const,
        result: {
          message_id: 999,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'supergroup' },
          text: (payload as Record<string, unknown>).text as string,
        },
      };
    }

    if (method === 'editMessageText') {
      return {
        ok: true as const,
        result: {
          message_id: (payload as Record<string, unknown>).message_id as number ?? 999,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'supergroup' },
          text: (payload as Record<string, unknown>).text as string,
        },
      };
    }

    // Generic fallback — good enough for most grammY calls
    return { ok: true as const, result: true };
  };

  return { calls, transformer };
}

/**
 * Builds a minimal grammY Update for a bot command.
 * `args` is the text after the slash-command (ctx.match equivalent).
 */
export function makeCommandUpdate(
  command: string,
  args = '',
  opts: { topicId?: number; chatId?: number; userId?: number } = {},
) {
  const chatId = opts.chatId ?? -1001234567890;
  const userId = opts.userId ?? 42;
  const text = args ? `/${command} ${args}` : `/${command}`;
  const commandLength = command.length + 1;

  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'supergroup' as const, title: 'Test Group' },
      ...(opts.topicId !== undefined ? { message_thread_id: opts.topicId } : {}),
      from: { id: userId, is_bot: false, first_name: 'Test', username: 'tester' },
      text,
      entities: [{ type: 'bot_command' as const, offset: 0, length: commandLength }],
    },
  };
}

/**
 * Builds a plain text message update (non-command) for relay testing.
 */
export function makeTextUpdate(
  text: string,
  opts: { topicId?: number; chatId?: number; userId?: number } = {},
) {
  const chatId = opts.chatId ?? -1001234567890;
  const userId = opts.userId ?? 42;

  return {
    update_id: 2,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'supergroup' as const, title: 'Test Group' },
      ...(opts.topicId !== undefined ? { message_thread_id: opts.topicId } : {}),
      from: { id: userId, is_bot: false, first_name: 'Test', username: 'tester' },
      text,
    },
  };
}
