import type { Bot, Context } from 'grammy';
import type { PermissionPolicy } from '../copilot/impl.js';
import type { CopilotSessionFactory } from '../copilot/factory.js';
import type { ISessionRegistry } from '../sessions/registry.js';
import type { SessionLookup } from '../relay/ports.js';
import type { ChannelPort, ChannelContext, CommandHandler } from '../channel/port.js';
import { Relay } from '../relay/relay.js';
import { ensurePromptRegistry } from './prompt.js';
import { isBotCommand, COMMAND_NAMES, type CommandName } from './commands.js';
import { loadConfig, saveConfig } from '../config/config.js';
import {
  validatePath,
  getKnownCwdByAlias,
  touchKnownCwd,
} from '../config/knownCwds.js';
import { parseNewFlags } from './newFlagParser.js';
import { handleCwdCommand, type CwdCommandLogger } from './cwdCommand.js';

/** DNS-label style: lowercase alphanumeric + hyphens, 1–63 chars, no leading hyphen. */
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface HandlerOptions {
  bot: Bot<Context>;
  registry: ISessionRegistry;
  factory: CopilotSessionFactory;
  globalModel: string;
  /** The active ChannelPort — used to register commands and relay. */
  channel: ChannelPort;
  permissionPolicy?: PermissionPolicy;
  telegramMirror?: { handleTelegramMessage(ctx: Context): Promise<boolean> };
  statusProvider?: { handleStatusCommand(channelCtx: ChannelContext): Promise<void> };
  /** Absolute path to config.json — required for /cwd commands and /new --cwd flag. */
  configPath?: string;
  logger?: CwdCommandLogger;
}

function defaultLogger(): CwdCommandLogger {
  return {
    info(meta, message) {
      console.log(`[bot] ${message}`, meta);
    },
    warn(meta, message) {
      console.warn(`[bot] ${message}`, meta);
    },
    error(meta, message) {
      console.error(`[bot] ${message}`, meta);
    },
  };
}

/**
 * Registers all bot commands and the catch-all relay handler via the ChannelPort.
 *
 * Commands:
 *   /new <name> [--model <model>] [--cwd <alias-or-path>]
 *                    — register a topic→name mapping (SDK session created lazily)
 *   /cwd list|add|remove  — manage the known-cwds registry (General Topic only)
 *   /list          — list all registered topic→session mappings
 *   /remove        — delete the session linked to the current topic
 *   /resume <name> — re-link a named session to the current topic (move semantics)
 *   /help          — show available commands
 *
 * All other text messages in forum topics are relayed to the linked session.
 */
export function registerHandlers({ bot, registry, factory, globalModel, channel, permissionPolicy, telegramMirror, statusProvider, configPath, logger }: HandlerOptions): Relay {
  void telegramMirror;
  const cwdLogger = logger ?? defaultLogger();
  const sessionLookup: SessionLookup = { resolve: (threadId) => registry.resolve(threadId) };

  const enablePermissionPrompts = permissionPolicy === 'interactiveDestructive';
  if (enablePermissionPrompts) {
    // Install the callback_query:data listener EAGERLY here, before bot.start()
    // begins polling. grammY forbids bot.on() registration from within active
    // handlers (memory-leak guard), so we must register during the setup phase
    // alongside the other bot.command() / bot.on() calls.
    ensurePromptRegistry(bot);
  }

  const relay = new Relay(channel, sessionLookup, factory, globalModel, enablePermissionPrompts);

  // Registered via the COMMAND_NAMES loop below; defined here so relay is in scope.
  const commandHandlers: Record<CommandName, CommandHandler> = {
    // /new <name> [--model <model>] [--cwd <alias-or-path>] — register a topic→name mapping; SDK session is created lazily on first relay
    new: async (channelCtx, args) => {
      if (!channelCtx.threadId) {
        await channel.sendMessage(channelCtx, '❌ /new must be used inside a forum topic.');
        return;
      }

      const input = args.trim();
      if (!input) {
        await channel.sendMessage(channelCtx, '❌ Usage: /new <session-name> [--model <model>] [--cwd <alias-or-path>]');
        return;
      }

      const parsed = parseNewFlags(input);
      if (!parsed.ok) {
        await channel.sendMessage(channelCtx, `❌ ${parsed.error}`);
        return;
      }
      const name = parsed.value.sessionName;
      const model = parsed.value.model;
      const cwdArg = parsed.value.cwd;

      if (!SESSION_NAME_RE.test(name)) {
        await channel.sendMessage(channelCtx,
          '❌ Invalid session name. Use lowercase letters, numbers, and hyphens (e.g. reach-myapp).',
        );
        return;
      }

      const existing = registry.resolve(channelCtx.threadId);
      if (existing) {
        await channel.sendMessage(channelCtx,
          `⚠️ Topic already linked to "${existing.sessionName}". Use /remove first.`,
        );
        return;
      }

      const nameTaken = registry.findByName(name);
      if (nameTaken) {
        await channel.sendMessage(channelCtx,
          `⚠️ Session name "${name}" is already in use (topic #${nameTaken.threadId}). Choose a different name.`,
        );
        return;
      }

      try {
        if (!channelCtx.channelId) {
          await channel.sendMessage(channelCtx, '❌ Could not determine chat ID.');
          return;
        }

        // Resolve --cwd if provided
        let resolvedCwd: string | undefined;
        if (cwdArg !== undefined) {
          if (!configPath) {
            await channel.sendMessage(channelCtx, '❌ --cwd requires a config path (daemon not fully configured).');
            return;
          }
          const isPath =
            /^[a-zA-Z]:\\/.test(cwdArg) ||
            cwdArg.startsWith('\\\\') ||
            cwdArg.startsWith('/');
          if (isPath) {
            const pathResult = await validatePath(cwdArg);
            if (!pathResult.ok) {
              await channel.sendMessage(channelCtx, `❌ Invalid path: ${pathResult.reason}. Path must be an absolute, existing directory.`);
              return;
            }
            if (pathResult.warning) {
              await channel.sendMessage(channelCtx, `⚠️ ${pathResult.warning}`);
            }
            resolvedCwd = pathResult.normalized;
          } else {
            const cfg = await loadConfig(configPath);
            const known = getKnownCwdByAlias(cfg, cwdArg);
            if (!known) {
              await channel.sendMessage(channelCtx, `❌ Unknown alias '${cwdArg}'. Run /cwd list to see known cwds.`);
              return;
            }
            resolvedCwd = known.path;
            await saveConfig(configPath, touchKnownCwd(cfg, cwdArg, new Date().toISOString()));
          }
        }

        await (
          resolvedCwd === undefined
            ? registry.register(channelCtx.threadId, channelCtx.channelId, name, model)
            : registry.register(channelCtx.threadId, channelCtx.channelId, name, model, resolvedCwd)
        );
        const modelNote = model ? ` (model: ${model})` : '';
        const cwdNote = resolvedCwd ? ` (cwd: ${resolvedCwd})` : '';
        await channel.sendMessage(channelCtx, `✅ Session "${name}" registered and linked to this topic${modelNote}${cwdNote}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await channel.sendMessage(channelCtx, `❌ Failed to register session "${name}": ${msg}`);
      }
    },

    // /list — show all registered sessions
    list: async (channelCtx) => {
      const sessions = registry.list();
      if (sessions.length === 0) {
        await channel.sendMessage(channelCtx, 'No sessions registered yet.');
        return;
      }
      const lines = sessions.map((s) => {
        const modelNote = s.model ? ` (model: ${s.model})` : '';
        return `• ${s.sessionName} ← topic #${s.threadId}${modelNote}`;
      });
      await channel.sendMessage(channelCtx, lines.join('\n'));
    },

    // /remove — unlink the session from this topic
    remove: async (channelCtx) => {
      if (!channelCtx.threadId) {
        await channel.sendMessage(channelCtx, '❌ /remove must be used inside a forum topic.');
        return;
      }

      const removed = await registry.remove(channelCtx.threadId);
      if (removed) {
        await channel.sendMessage(channelCtx, '✅ Session unlinked from this topic.');
      } else {
        await channel.sendMessage(channelCtx, '⚠️ No session is linked to this topic.');
      }
    },

    // /resume <name> — re-link a named session to the current topic (move semantics)
    resume: async (channelCtx, args) => {
      if (!channelCtx.threadId) {
        await channel.sendMessage(channelCtx, '❌ /resume must be used inside a forum topic. Run /resume inside the topic you want to bind.');
        return;
      }

      const name = args.trim();
      if (!name) {
        await channel.sendMessage(channelCtx, '❌ Usage: /resume <session-name>');
        return;
      }

      if (!SESSION_NAME_RE.test(name)) {
        await channel.sendMessage(channelCtx,
          '❌ Invalid session name. Use lowercase letters, numbers, and hyphens (e.g. reach-myapp).',
        );
        return;
      }

      const matches = registry.findAllByName(name);
      if (matches.length === 0) {
        const allNames = registry.list().map((e) => e.sessionName);
        const close = allNames.filter((n) => n.includes(name) || name.includes(n)).slice(0, 3);
        const hint = close.length > 0
          ? ` Did you mean: ${close.map((n) => `"${n}"`).join(', ')}?`
          : ' Use /list to see available sessions.';
        await channel.sendMessage(channelCtx, `❌ No session named "${name}" found.${hint}`);
        return;
      }

      // F-B: refuse when legacy duplicate names exist — cannot safely pick one
      if (matches.length > 1) {
        const lines = matches.map((e) => `  • topic #${e.threadId} (channelId ${e.channelId})`).join('\n');
        await channel.sendMessage(channelCtx,
          `⚠️ Multiple sessions named "${name}" exist (legacy duplicates):\n${lines}\nCannot disambiguate. Use /remove in the topic of the entry you want to drop, then /resume here.`,
        );
        return;
      }

      const found = matches[0]!;

      if (found.threadId === channelCtx.threadId) {
        await channel.sendMessage(channelCtx, `✅ Session "${name}" is already bound to this topic.`);
        return;
      }

      const currentBinding = registry.resolve(channelCtx.threadId);
      if (currentBinding) {
        await channel.sendMessage(channelCtx,
          `⚠️ Topic already linked to "${currentBinding.sessionName}". Use /remove first.`,
        );
        return;
      }

      const oldThreadId = found.threadId;
      try {
        await registry.move(oldThreadId, channelCtx.threadId);
        // Migrate the live SDK session handle so the next message in the new topic
        // reuses it instead of creating a duplicate session (H-A).
        relay.rekeySession(oldThreadId, channelCtx.threadId);
        await channel.sendMessage(channelCtx,
          `✅ Resumed session "${name}" (was bound to topic #${oldThreadId}).`,
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes('already bound to')) {
          // F-C: destination was bound by a concurrent operation after our pre-check
          await channel.sendMessage(channelCtx,
            `⚠️ Cannot resume "${name}": topic ${channelCtx.threadId} was just linked to another session. Use /remove first.`,
          );
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          await channel.sendMessage(channelCtx, `❌ Failed to resume session "${name}": ${msg}`);
        }
      }
    },

    // /help — show available commands
    help: async (channelCtx) => {
      const helpText = `Reach — Telegram ↔ Copilot CLI bridge

Commands:
/new <name> [--model <model>] [--cwd <alias-or-path>] — Create a session in this topic
/resume <name> — Re-link an existing session to this topic
/list — Show all active sessions
/remove — Unlink the session from this topic
/status — Show current AFK session status
/pair <code> — Pair this chat with the Reach daemon
/cwd list|add|remove — Manage known cwd aliases (General Topic only)
/help — Show this message`;
      await channel.sendMessage(channelCtx, helpText);
    },

    // /pair — guide users to pair during daemon startup
    pair: async (channelCtx) => {
      await channel.sendMessage(channelCtx,
        '⚠️ Pairing is only available during daemon startup. To re-pair: stop the daemon, delete config.json, and restart.',
      );
    },

    // /status — send current session orientation message (AFK topics only)
    status: async (channelCtx) => {
      if (!statusProvider) {
        await channel.sendMessage(channelCtx, '⚠️ Status requires the extension bridge to be active.');
        return;
      }
      await statusProvider.handleStatusCommand(channelCtx);
    },

    // /cwd list|add|remove — manage the known-cwds registry (General Topic only)
    cwd: async (channelCtx, args) => {
      try {
        await handleCwdCommand(channelCtx, args, channel, {
          logger: cwdLogger,
          ...(configPath !== undefined && { configPath }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await channel.sendMessage(channelCtx, `❌ Failed to process /cwd command: ${msg}`);
      }
    },
  };

  for (const name of COMMAND_NAMES) {
    channel.onCommand(name, commandHandlers[name]);
  }

  // Relay all non-command text messages in forum topics to their linked session
  channel.onMessage(async (channelCtx, text) => {
    if (!channelCtx.threadId) return;
    if (isBotCommand(text)) return;
    await relay.relay(channelCtx, text);
  });

  return relay;
}
