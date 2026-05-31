/**
 * Telegram bot command registry.
 *
 * BOT_COMMANDS is the single authoritative set of commands this bot handles
 * via BotFather registration. It drives the isBotCommand() guard used in
 * two places:
 *
 *   - afkMode.ts handleTelegramMessage() — AFK topic input path
 *   - handlers.ts message:text handler   — non-AFK relay path
 *
 * Phase 9 pass-through rationale: any `/foo` that is NOT in BOT_COMMANDS is
 * treated as a CLI command and forwarded verbatim via mirror.input. This lets
 * users type `/clear`, `/agent`, `/model`, etc. in Telegram topics and have
 * them reach the CLI session unchanged, with zero per-command daemon work.
 *
 * Source-of-truth citations for the command list:
 *   handlers.ts:53  — bot.command('new', ...)
 *   handlers.ts:131 — bot.command('list', ...)
 *   handlers.ts:145 — bot.command('remove', ...)
 *   handlers.ts:161 — bot.command('resume', ...)
 *   handlers.ts:244 — bot.command('help', ...)
 *   handlers.ts:259 — bot.command('pair', ...)
 *   handlers.ts     — bot.command('status', ...)
 *   handlers.ts     — bot.command('cwd', ...) (Phase 9 Item 3)
 */

export const BOT_COMMANDS: ReadonlySet<string> = new Set([
  'new',
  'list',
  'remove',
  'resume',
  'help',
  'pair',
  'status',
  'cwd',
]);

/**
 * Returns true if `text` is a Telegram bot command handled by this daemon.
 *
 * A message is a bot command when it starts with `/` and the command word
 * (everything between `/` and the first space or end-of-string) is in
 * BOT_COMMANDS. The check is case-insensitive: `/NEW` and `/new` both match.
 *
 * Any `/foo` NOT in BOT_COMMANDS is treated as a CLI command for pass-through
 * (Phase 9 Item 2 — slash command relay via mirror.input).
 */
export function isBotCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const match = text.match(/^\/([a-zA-Z_]+)/);
  return match !== null && BOT_COMMANDS.has(match[1]!.toLowerCase());
}
