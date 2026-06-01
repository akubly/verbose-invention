/**
 * /cwd command handler for the Reach bot.
 *
 * This module owns the General-Topic-only enforcement for /cwd commands and
 * dispatches to three sub-commands: list, add, remove.  It bridges Telegram
 * context (grammy Context) to the knownCwds registry helpers and the config
 * persistence layer.
 *
 * All /cwd commands are restricted to the General Topic (message_thread_id
 * undefined).  Attempting to run /cwd from a non-General topic is rejected
 * with an explanatory error.
 */

import type { Context } from 'grammy';
import type { ReachConfig } from '../config/config.js';
import {
  validateAlias,
  validatePath,
  listKnownCwds,
  getKnownCwdByAlias,
  addKnownCwd,
  removeKnownCwd,
} from '../config/knownCwds.js';
import { loadConfig, saveConfig } from '../config/config.js';

export interface CwdCommandLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface CwdCommandOptions {
  configPath?: string;
  logger: CwdCommandLogger;
  config?: {
    loadConfig(configPath: string): Promise<ReachConfig>;
    saveConfig(configPath: string, config: ReachConfig): Promise<void>;
  };
}

// Human-readable age: 'just now' | 'Xm ago' | 'Xh ago' | 'Xd ago'
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Handles the /cwd command and its sub-commands.
 *
 * Sub-commands:
 *   `list`           — display all known cwds sorted by last-used date
 *   `add <alias> <path>` — validate and register a new alias → absolute-path mapping
 *   `remove <alias>` — remove an existing alias from the registry
 *
 * Enforcement:
 *   - Restricted to the General Topic (no `message_thread_id`).  Calls from
 *     named topics receive an informative rejection.
 *   - When `options.configPath` is undefined the command is unavailable and
 *     the user is told so explicitly.
 *
 * Dispatches by the first argument token (sub-command).  Unknown sub-commands
 * receive a usage hint.  Structured events are logged via `options.logger`
 * at info/warn/error level for every significant action.
 */
export async function handleCwdCommand(ctx: Context, options: CwdCommandOptions): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  if (topicId !== undefined) {
    await ctx.reply(
      '❌ /cwd commands work in the General Topic only. Manage your cwd registry there, then start sessions from any topic.',
      { message_thread_id: topicId },
    );
    return;
  }

  if (!options.configPath) {
    await ctx.reply('❌ /cwd is not available (config path not configured).');
    return;
  }

  const configApi = options.config ?? { loadConfig, saveConfig };
  const matchText =
    typeof ctx.match === 'string'
      ? ctx.match
      : Array.isArray(ctx.match)
        ? ctx.match[0] ?? ''
        : '';
  const args = matchText.trim().split(/\s+/).filter(Boolean);
  const subCmd = args[0]?.toLowerCase() ?? 'list';

  if (subCmd === 'list') {
    const config = await configApi.loadConfig(options.configPath);
    const cwds = listKnownCwds(config);
    if (cwds.length === 0) {
      await ctx.reply('📂 No known cwds yet. Add one with: /cwd add <alias> <path>');
      return;
    }
    const lines = cwds.map((c) => {
      const used = c.lastUsedAt ? `last used ${relativeTime(c.lastUsedAt)}` : 'never used';
      return `• ${c.alias} — ${c.path}  (${used})`;
    });
    await ctx.reply(`📂 Known cwds:\n${lines.join('\n')}\n\nStart one with: /new <session-name> --cwd <alias>`);
    return;
  }

  if (subCmd === 'add') {
    const alias = args[1];
    const rawPath = args.slice(2).join(' ');
    if (!alias || !rawPath) {
      await ctx.reply('❌ Usage: /cwd add <alias> <path>');
      return;
    }

    const config = await configApi.loadConfig(options.configPath);
    const aliasResult = validateAlias(alias);
    if (!aliasResult.ok) {
      options.logger.warn({ alias, reason: aliasResult.reason }, 'cwd add invalid alias');
      await ctx.reply(
        `❌ Invalid alias: ${aliasResult.reason}. Aliases must be 1-32 chars, start alphanumeric, use letters/digits/hyphens/underscores.`,
      );
      return;
    }

    const existingAlias = getKnownCwdByAlias(config, alias);
    if (existingAlias) {
      options.logger.warn(
        { alias, existing_path: existingAlias.path },
        'cwd add collision',
      );
      await ctx.reply(
        `❌ Alias '${alias}' already exists for ${existingAlias.path}. Use a different name or run /cwd remove ${alias} first.`,
      );
      return;
    }

    const pathResult = await validatePath(rawPath);
    if (!pathResult.ok) {
      options.logger.warn({ path: rawPath, reason: pathResult.reason }, 'cwd add invalid path');
      await ctx.reply(
        `❌ Invalid path: ${pathResult.reason}. Path must be an absolute, existing directory.`,
      );
      return;
    }

    if (pathResult.warning) {
      await ctx.reply(`⚠️ ${pathResult.warning}`);
    }

    const newConfig = addKnownCwd(config, alias, pathResult.normalized, new Date().toISOString());
    try {
      await configApi.saveConfig(options.configPath, newConfig);
    } catch (err) {
      options.logger.error({ err }, 'cwd config save failed');
      throw err;
    }
    options.logger.info({ alias, path: pathResult.normalized }, 'cwd added');
    await ctx.reply(`✅ Added '${alias}' → ${pathResult.normalized}`);
    return;
  }

  if (subCmd === 'remove') {
    const alias = args[1];
    if (!alias) {
      await ctx.reply('❌ Usage: /cwd remove <alias>');
      return;
    }

    const config = await configApi.loadConfig(options.configPath);
    const found = getKnownCwdByAlias(config, alias);
    if (!found) {
      options.logger.info({ alias }, 'cwd remove not found');
      await ctx.reply(`❌ Alias '${alias}' not found. Run /cwd list to see known cwds.`);
      return;
    }

    const newConfig = removeKnownCwd(config, alias);
    try {
      await configApi.saveConfig(options.configPath, newConfig);
    } catch (err) {
      options.logger.error({ err }, 'cwd config save failed');
      throw err;
    }
    options.logger.info({ alias }, 'cwd removed');
    await ctx.reply(`✅ Removed '${alias}'.`);
    return;
  }

  await ctx.reply('❌ Unknown sub-command. Usage: /cwd list | /cwd add <alias> <path> | /cwd remove <alias>');
}
