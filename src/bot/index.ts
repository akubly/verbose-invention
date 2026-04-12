import { Bot } from 'grammy';

/**
 * Creates the grammY Bot instance with an optional chat ID guard.
 *
 * Expects to be used in a Telegram supergroup with is_forum: true.
 * Pass the result to registerHandlers() to wire up commands and the relay.
 *
 * @param token        Bot token from @BotFather.
 * @param allowedChatId If set, the bot ignores all messages from other chats.
 *                      Read from TELEGRAM_CHAT_ID env var in the DI root.
 */
export function createBot(token: string, allowedChatId?: number): Bot {
  const bot = new Bot(token);

  // Guard: ignore messages from groups other than the configured chat
  if (allowedChatId !== undefined) {
    bot.use(async (ctx, next) => {
      if (ctx.chat?.id !== allowedChatId) return;
      await next();
    });
  }

  return bot;
}
