import type { Bot, Context } from 'grammy';
import type { CopilotSessionFactory } from '../copilot/factory.js';
import type { ISessionRegistry } from '../sessions/registry.js';
import { Relay } from '../relay/relay.js';

/** DNS-label style: lowercase alphanumeric + hyphens, 1–63 chars, no leading hyphen. */
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}$/;

export interface HandlerOptions {
  bot: Bot<Context>;
  registry: ISessionRegistry;
  factory: CopilotSessionFactory;
}

/**
 * Registers all bot commands and the catch-all relay handler.
 *
 * Commands:
 *   /new <name>   — register a topic→name mapping in the session registry
 *                    (the SDK session is created lazily on first relayed message)
 *   /list         — list all registered topic→session mappings
 *   /remove       — delete the session linked to the current topic
 *
 * All other text messages in forum topics are relayed to the linked session.
 */
export function registerHandlers({ bot, registry, factory }: HandlerOptions): Relay {
  const relay = new Relay(registry, factory);

  // /new <name> — register a topic→name mapping; SDK session is created lazily on first relay
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

    if (!SESSION_NAME_RE.test(name)) {
      await ctx.reply(
        '❌ Invalid session name. Use lowercase letters, numbers, and hyphens (e.g. reach-myapp).',
        { message_thread_id: topicId },
      );
      return;
    }

    const existing = registry.resolve(topicId);
    if (existing) {
      await ctx.reply(
        `⚠️ Topic already linked to "${existing.sessionName}". Use /remove first.`,
        { message_thread_id: topicId },
      );
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply('❌ Could not determine chat ID.', { message_thread_id: topicId });
        return;
      }
      await registry.register(topicId, chatId, name);
      await ctx.reply(`✅ Session \`${name}\` registered and linked to this topic.`, {
        message_thread_id: topicId,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Failed to register session "${name}": ${msg}`, {
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
    const lines = sessions.map((s) => `• ${s.sessionName} ← topic #${s.topicId}`);
    await ctx.reply(lines.join('\n'));
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

  return relay;
}
