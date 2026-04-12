import type { Bot, Context } from 'grammy';
import type { CopilotClient } from '../types.js';
import type { ISessionRegistry } from '../sessions/registry.js';
import { Relay } from '../relay/relay.js';

export interface HandlerOptions {
  bot: Bot<Context>;
  registry: ISessionRegistry;
  sdk: CopilotClient;
}

/**
 * Registers all bot commands and the catch-all relay handler.
 *
 * Commands:
 *   /new <name>   — create a Copilot session and link it to the current topic
 *   /list         — list all registered topic→session mappings
 *   /remove       — delete the session linked to the current topic
 *
 * All other text messages in forum topics are relayed to the linked session.
 */
export function registerHandlers({ bot, registry, sdk }: HandlerOptions): void {
  const relay = new Relay(registry, sdk);

  // /new <name> — create a Copilot session and link it to this topic
  bot.command('new', async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('❌ /new must be used inside a forum topic.');
      return;
    }

    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply('❌ Usage: /new <session-name>', { message_thread_id: topicId });
      return;
    }

    const existing = registry.resolve(topicId);
    if (existing) {
      await ctx.reply(
        `⚠️ Topic already linked to "${existing.name}". Use /remove first.`,
        { message_thread_id: topicId },
      );
      return;
    }

    try {
      const session = await sdk.createSession({ name });
      await registry.register({
        name,
        telegramTopicId: topicId,
        copilotSessionId: session.id,
        createdAt: new Date().toISOString(),
      });
      await ctx.reply(`✅ Session \`${name}\` created and linked to this topic.`, {
        message_thread_id: topicId,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Failed to create session "${name}": ${msg}`, {
        message_thread_id: topicId,
      });
    }
  });

  // /list — show all registered sessions
  bot.command('list', async (ctx) => {
    const sessions = registry.list();
    if (sessions.length === 0) {
      await ctx.reply('No sessions registered yet.');
      return;
    }
    const lines = sessions.map((s) => `• \`${s.name}\` ← topic #${s.telegramTopicId}`);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /remove — unlink the session from this topic
  bot.command('remove', async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('❌ /remove must be used inside a forum topic.');
      return;
    }

    const removed = await registry.remove(topicId);
    if (removed) {
      await ctx.reply('✅ Session unlinked from this topic.', { message_thread_id: topicId });
    } else {
      await ctx.reply('⚠️ No session is linked to this topic.', { message_thread_id: topicId });
    }
  });

  // Relay all non-command text messages in forum topics to their linked session
  bot.on('message:text', async (ctx) => {
    if (!ctx.message.message_thread_id) return;
    if (ctx.message.text.startsWith('/')) return;
    await relay.relay(ctx);
  });

  bot.catch((err) => {
    console.error('[bot] Unhandled error:', err.message, err.error);
  });
}
