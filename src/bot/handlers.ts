import type { Bot, Context } from 'grammy';
import type { PermissionPolicy } from '../copilot/impl.js';
import type { CopilotSessionFactory } from '../copilot/factory.js';
import type { ISessionRegistry } from '../sessions/registry.js';
import type { SessionLookup, PermissionPrompter } from '../relay/ports.js';
import { Relay } from '../relay/relay.js';
import { promptUserForPermission } from './prompt.js';

/** DNS-label style: lowercase alphanumeric + hyphens, 1–63 chars, no leading hyphen. */
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface HandlerOptions {
  bot: Bot<Context>;
  registry: ISessionRegistry;
  factory: CopilotSessionFactory;
  globalModel: string;
  permissionPolicy?: PermissionPolicy;
}

/**
 * Registers all bot commands and the catch-all relay handler.
 *
 * Commands:
 *   /new <name>    — register a topic→name mapping in the session registry
 *                    (the SDK session is created lazily on first relayed message)
 *   /list          — list all registered topic→session mappings
 *   /remove        — delete the session linked to the current topic
 *   /resume <name> — re-link a named session to the current topic (move semantics)
 *   /help          — show available commands
 *
 * All other text messages in forum topics are relayed to the linked session.
 */
export function registerHandlers({ bot, registry, factory, globalModel, permissionPolicy }: HandlerOptions): Relay {
  const sessionLookup: SessionLookup = { resolve: (topicId) => registry.resolve(topicId) };

  let permissionPrompter: PermissionPrompter | undefined;
  if (permissionPolicy === 'interactiveDestructive') {
    permissionPrompter = {
      prompt: (chatId, topicId, toolName, args) =>
        promptUserForPermission(bot, chatId, topicId, toolName, args),
    };
  }

  const relay = new Relay(sessionLookup, factory, globalModel, permissionPrompter);

  // /new <name> [--model <model>] — register a topic→name mapping; SDK session is created lazily on first relay
  bot.command('new', async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('❌ /new must be used inside a forum topic.');
      return;
    }

    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply('❌ Usage: /new <session-name> [--model <model>]', { message_thread_id: topicId });
      return;
    }

    // Parse name and optional --model flag
    let name = input;
    let model: string | undefined;
    
    // Check for --model flag
    if (/\s--model(\s|$)/.test(input)) {
      const modelMatch = input.match(/^(.+?)\s+--model\s+(\S+)$/);
      if (modelMatch && modelMatch[1] && modelMatch[2]) {
        name = modelMatch[1].trim();
        model = modelMatch[2].trim();
      } else {
        // --model flag present but no value provided
        await ctx.reply('❌ --model flag requires a model value (e.g., --model claude-opus-4.5)', {
          message_thread_id: topicId,
        });
        return;
      }
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

    const nameTaken = registry.findByName(name);
    if (nameTaken) {
      await ctx.reply(
        `⚠️ Session name "${name}" is already in use (topic #${nameTaken.topicId}). Choose a different name.`,
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
      await registry.register(topicId, chatId, name, model);
      const modelNote = model ? ` (model: ${model})` : '';
      await ctx.reply(`✅ Session "${name}" registered and linked to this topic${modelNote}.`, {
        message_thread_id: topicId,
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
    const lines = sessions.map((s) => {
      const modelNote = s.model ? ` (model: ${s.model})` : '';
      return `• ${s.sessionName} ← topic #${s.topicId}${modelNote}`;
    });
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

  // /resume <name> — re-link a named session to the current topic (move semantics)
  bot.command('resume', async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('❌ /resume must be used inside a forum topic. Run /resume inside the topic you want to bind.');
      return;
    }

    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply('❌ Usage: /resume <session-name>', { message_thread_id: topicId });
      return;
    }

    if (!SESSION_NAME_RE.test(name)) {
      await ctx.reply(
        '❌ Invalid session name. Use lowercase letters, numbers, and hyphens (e.g. reach-myapp).',
        { message_thread_id: topicId },
      );
      return;
    }

    const matches = registry.findAllByName(name);
    if (matches.length === 0) {
      const allNames = registry.list().map((e) => e.sessionName);
      const close = allNames.filter((n) => n.includes(name) || name.includes(n)).slice(0, 3);
      const hint = close.length > 0
        ? ` Did you mean: ${close.map((n) => `"${n}"`).join(', ')}?`
        : ` Use /list to see available sessions.`;
      await ctx.reply(`❌ No session named "${name}" found.${hint}`, { message_thread_id: topicId });
      return;
    }

    // F-B: refuse when legacy duplicate names exist — cannot safely pick one
    if (matches.length > 1) {
      const lines = matches.map((e) => `  • topic #${e.topicId} (chatId ${e.chatId})`).join('\n');
      await ctx.reply(
        `⚠️ Multiple sessions named "${name}" exist (legacy duplicates):\n${lines}\nCannot disambiguate — please rename one with /rename or /remove the unwanted entry.`,
        { message_thread_id: topicId },
      );
      return;
    }

    const found = matches[0]!;

    if (found.topicId === topicId) {
      await ctx.reply(`✅ Session "${name}" is already bound to this topic.`, { message_thread_id: topicId });
      return;
    }

    const currentBinding = registry.resolve(topicId);
    if (currentBinding) {
      await ctx.reply(
        `⚠️ Topic already linked to "${currentBinding.sessionName}". Use /remove first.`,
        { message_thread_id: topicId },
      );
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply('❌ Could not determine chat ID.', { message_thread_id: topicId });
      return;
    }

    const oldTopicId = found.topicId;
    try {
      await registry.move(oldTopicId, topicId, name, chatId, found.model);
      await ctx.reply(
        `✅ Resumed session "${name}" (was bound to topic #${oldTopicId}).`,
        { message_thread_id: topicId },
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('already bound to')) {
        // F-C: destination was bound by a concurrent operation after our pre-check
        await ctx.reply(
          `⚠️ Cannot resume "${name}": topic ${topicId} was just linked to another session. Use /remove first.`,
          { message_thread_id: topicId },
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Failed to resume session "${name}": ${msg}`, { message_thread_id: topicId });
      }
    }
  });

  // /help — show available commands
  bot.command('help', async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const helpText = `Reach — Telegram ↔ Copilot CLI bridge

Commands:
/new <name> [--model <model>] — Create a session in this topic
/resume <name> — Re-link an existing session to this topic
/list — Show all active sessions
/remove — Unlink the session from this topic
/pair <code> — Pair this chat with the Reach daemon
/help — Show this message`;
    await ctx.reply(helpText, topicId ? { message_thread_id: topicId } : undefined);
  });

  // /pair — guide users to pair during daemon startup
  bot.command('pair', async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    await ctx.reply(
      '⚠️ Pairing is only available during daemon startup. To re-pair: stop the daemon, delete config.json, and restart.',
      topicId ? { message_thread_id: topicId } : undefined,
    );
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
