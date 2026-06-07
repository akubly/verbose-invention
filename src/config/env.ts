/**
 * Environment and config resolution for Reach.
 *
 * parseEnv() reads all env vars and the persisted config, validates them,
 * and returns a fully-resolved EnvConfig DTO. Fatal validation errors write
 * a [reach]-prefixed message to stderr and call process.exit(1).
 */

import * as path from 'path';
import type { PermissionPolicy } from '../copilot/impl.js';
import { loadConfig, getConfigPath, getReachDataDir } from './config.js';

export interface EnvConfig {
  /**
   * Telegram bot token. Defined when reachChannel is 'telegram'; undefined otherwise.
   * Always defined when isPairingMode is true (pairing is Telegram-only).
   */
  token: string | undefined;
  /** Defined when isPairingMode is false and reachChannel is 'telegram'; undefined otherwise. */
  chatId: number | undefined;
  isPairingMode: boolean;
  model: string;
  permissionPolicy: PermissionPolicy;
  allowedUserIdSet: ReadonlySet<number> | undefined;
  configPath: string;
  registryPath: string;
  /** The transport channel to use. Defaults to 'telegram'. */
  reachChannel: string;
}

export async function parseEnv(): Promise<EnvConfig> {
  const reachChannel = process.env.REACH_CHANNEL ?? 'telegram';

  const model = process.env.REACH_MODEL ?? 'claude-sonnet-4';

  const validPolicies = ['approveAll', 'denyAll', 'interactiveDestructive'] as const;
  const rawPolicy = process.env.REACH_PERMISSION_POLICY ?? 'approveAll';
  if (!validPolicies.includes(rawPolicy as PermissionPolicy)) {
    console.error(`[reach] Fatal: REACH_PERMISSION_POLICY must be one of: ${validPolicies.join(', ')}`);
    process.exit(1);
  }
  const permissionPolicy = rawPolicy as PermissionPolicy;

  const configPath = getConfigPath();
  const registryPath = path.join(getReachDataDir(), 'registry.json');
  const config = await loadConfig(configPath);

  // Telegram-specific credential resolution — only required when the telegram transport is selected.
  let token: string | undefined;
  let chatId: number | undefined;

  if (reachChannel === 'telegram') {
    token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('[reach] Fatal: TELEGRAM_BOT_TOKEN is required');
      process.exit(1);
    }

    // Resolve chat ID: env var > config.json > pairing mode
    const rawChatId = process.env.TELEGRAM_CHAT_ID;
    if (rawChatId) {
      chatId = Number(rawChatId);
      if (!Number.isInteger(chatId)) {
        console.error('[reach] Fatal: TELEGRAM_CHAT_ID must be a valid integer');
        process.exit(1);
      }
      if (chatId === 0) {
        console.error('[reach] Fatal: TELEGRAM_CHAT_ID cannot be 0 — set to a real chat ID or leave unset for pairing mode.');
        process.exit(1);
      }
    } else if (config.telegramChatId) {
      chatId = config.telegramChatId;
      console.log(`[reach] Using chat ID from config: ***${String(chatId).slice(-4)}`);
    }
  }

  let allowedUserIdSet: ReadonlySet<number> | undefined;
  if (process.env.TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    const rawAllowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS.trim();
    if (rawAllowedUserIds.length === 0) {
      console.error(
        '[reach] Fatal: TELEGRAM_ALLOWED_USER_IDS is set to an empty value — this is a misconfiguration. ' +
        'Unset the variable to allow all chat members, or provide a comma-separated list of user IDs.',
      );
      process.exit(1);
    }
    const tokens = rawAllowedUserIds.split(',').map((id) => id.trim());
    const parsedIds = tokens.map((id) => Number(id));
    if (tokens.some((id) => id.length === 0) || parsedIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      console.error('[reach] Fatal: TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of positive integer Telegram user IDs');
      process.exit(1);
    }
    allowedUserIdSet = new Set(parsedIds);
  } else if (Object.prototype.hasOwnProperty.call(config, 'telegramAllowedUserIds')) {
    if (!Array.isArray(config.telegramAllowedUserIds) || config.telegramAllowedUserIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      console.error('[reach] Fatal: telegramAllowedUserIds in config must be an array of positive integer Telegram user IDs');
      process.exit(1);
    }
    allowedUserIdSet = new Set(config.telegramAllowedUserIds);
  }

  if (allowedUserIdSet !== undefined && allowedUserIdSet.size === 0) {
    console.error('[reach] Fatal: allowed user list is empty (env var TELEGRAM_ALLOWED_USER_IDS or config telegramAllowedUserIds resolved to size 0) — this would deny all users. Unset to allow all, or provide at least one ID.');
    process.exit(1);
  }

  // Warn that all chat members can trigger AFK mirror input (security-relevant; only when chatId is known)
  if (chatId !== undefined && allowedUserIdSet === undefined) {
    console.warn(
      `[reach] ⚠️  TELEGRAM_ALLOWED_USER_IDS is not configured — ALL members of chat ${chatId} can send AFK mirror input to this machine. To restrict, set TELEGRAM_ALLOWED_USER_IDS to a comma-separated list of allowed Telegram user IDs.`,
    );
  }

  return {
    token,
    chatId,
    isPairingMode: reachChannel === 'telegram' && chatId === undefined,
    model,
    permissionPolicy,
    allowedUserIdSet,
    configPath,
    registryPath,
    reachChannel,
  };
}
