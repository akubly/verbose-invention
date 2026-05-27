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
  token: string;
  /** Defined when isPairingMode is false; undefined when no chat ID is known yet. */
  chatId: number | undefined;
  isPairingMode: boolean;
  model: string;
  permissionPolicy: PermissionPolicy;
  allowedUserIdSet: ReadonlySet<number> | undefined;
  configPath: string;
  registryPath: string;
}

export async function parseEnv(): Promise<EnvConfig> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[reach] Fatal: TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

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

  // Resolve chat ID: env var > config.json > pairing mode
  let chatId: number | undefined;
  const rawChatId = process.env.TELEGRAM_CHAT_ID;
  if (rawChatId) {
    chatId = Number(rawChatId);
    if (!Number.isInteger(chatId)) {
      console.error('[reach] Fatal: TELEGRAM_CHAT_ID must be a valid integer');
      process.exit(1);
    }
  } else if (config.telegramChatId) {
    chatId = config.telegramChatId;
    console.log(`[reach] Using chat ID from config: ***${String(chatId).slice(-4)}`);
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

  // Warn that all chat members can trigger AFK mirror input (security-relevant; only when chatId is known)
  if (chatId !== undefined && allowedUserIdSet === undefined) {
    console.warn(
      `[reach] ⚠️  TELEGRAM_ALLOWED_USER_IDS is not configured — ALL members of chat ${chatId} can send AFK mirror input to this machine. To restrict, set TELEGRAM_ALLOWED_USER_IDS to a comma-separated list of allowed Telegram user IDs.`,
    );
  }

  return {
    token,
    chatId,
    isPairingMode: chatId === undefined,
    model,
    permissionPolicy,
    allowedUserIdSet,
    configPath,
    registryPath,
  };
}
