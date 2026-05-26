/**
 * Reach — DI root and daemon entry point.
 *
 * Wires the Telegram bot, session registry, and Copilot SDK factory,
 * then starts long-polling. Graceful shutdown on SIGINT/SIGTERM.
 */

import 'dotenv/config';
import * as path from 'path';
import * as crypto from 'crypto';
import { createBot } from './bot/index.js';
import { registerHandlers } from './bot/handlers.js';
import { SessionRegistry } from './sessions/registry.js';
import { CopilotClientImpl, type PermissionPolicy } from './copilot/impl.js';
import { loadConfig, saveConfig, getConfigPath, getReachDataDir } from './config/config.js';
import { Bot } from 'grammy';
import { ExtensionBridge } from './bridge/extensionBridge.js';
import { AfkModeController } from './bot/afkMode.js';
import { BridgeSessionFactory } from './bridge/bridgeSessionFactory.js';
import { CompositeSessionFactory } from './bridge/compositeSessionFactory.js';
import { generatePipeAuth, cleanupPipeAuth } from './bridge/pipeAuth.js';
import type { CopilotSessionFactory } from './copilot/factory.js';

function getRegistryPath(): string {
  return path.join(getReachDataDir(), 'registry.json');
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[reach] Fatal: TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  const model = process.env.REACH_MODEL ?? 'claude-sonnet-4';
  
  // Validate permission policy
  const validPolicies = ['approveAll', 'denyAll', 'interactiveDestructive'] as const;
  const rawPolicy = process.env.REACH_PERMISSION_POLICY ?? 'approveAll';
  if (!validPolicies.includes(rawPolicy as PermissionPolicy)) {
    console.error(`[reach] Fatal: REACH_PERMISSION_POLICY must be one of: ${validPolicies.join(', ')}`);
    process.exit(1);
  }
  const permissionPolicy = rawPolicy as PermissionPolicy;
  
  const registryPath = getRegistryPath();
  const configPath = getConfigPath();

  // Resolve chat ID: env var > config.json > pairing mode
  let chatId: number | undefined;
  let allowedUserIdSet: ReadonlySet<number> | undefined;
  const config = await loadConfig(configPath);

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

  if (process.env.TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    const rawAllowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS.trim();
    if (rawAllowedUserIds.length > 0) {
      const tokens = rawAllowedUserIds.split(',').map((id) => id.trim());
      const parsedIds = tokens.map((id) => Number(id));
      if (tokens.some((id) => id.length === 0) || parsedIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        console.error('[reach] Fatal: TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of positive integer Telegram user IDs');
        process.exit(1);
      }
      allowedUserIdSet = new Set(parsedIds);
    }
  } else if (Object.prototype.hasOwnProperty.call(config, 'telegramAllowedUserIds')) {
    if (!Array.isArray(config.telegramAllowedUserIds) || config.telegramAllowedUserIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      console.error('[reach] Fatal: telegramAllowedUserIds in config must be an array of positive integer Telegram user IDs');
      process.exit(1);
    }
    allowedUserIdSet = new Set(config.telegramAllowedUserIds);
  }

  // If no chat ID, enter pairing mode
  if (!chatId) {
    const pairingCode = String(crypto.randomInt(100000, 1000000));
    console.log(`[reach] No TELEGRAM_CHAT_ID set. Pairing mode active.`);
    console.log(`[reach] Pairing code: ${pairingCode} (expires in 5 minutes)`);

    const pairingBot = new Bot(token); // No guard during pairing
    const timeout = setTimeout(() => {
      console.error('[reach] Pairing code expired. Restart to try again.');
      process.exit(1);
    }, 5 * 60 * 1000);

    pairingBot.command('pair', async (ctx) => {
      const userCode = ctx.match?.trim();
      if (userCode === pairingCode) {
        const chatType = ctx.chat?.type;
        if (chatType !== 'supergroup') {
          await ctx.reply('❌ Pairing must be done from a supergroup with forum topics enabled.');
          return;
        }
        const pairedChatId = ctx.chat?.id;
        if (!pairedChatId) {
          await ctx.reply('❌ Could not determine chat ID.');
          return;
        }
        await saveConfig(configPath, {
          telegramChatId: pairedChatId,
          ...(ctx.from?.id !== undefined && { telegramAllowedUserIds: [ctx.from.id] }),
        });
        clearTimeout(timeout);
        await ctx.reply(`✅ Paired! Chat ID saved. Restarting...`);
        console.log(`[reach] Paired with chat ${pairedChatId}. Restart to begin normal operation.`);
        process.exit(0);
      } else {
        await ctx.reply('❌ Invalid pairing code.');
      }
    });

    await pairingBot.start();
    return;
  }

  // Normal operation
  const registry = new SessionRegistry(registryPath);

  // Start the extension bridge (named pipe server). If the pipe is already in use
  // (e.g. another daemon instance running), log a warning and continue without it —
  // SDK sessions will still work; only extension-attached sessions will be unavailable.
  let bridge: ExtensionBridge | null = null;
  try {
    const pipeAuth = await generatePipeAuth();
    bridge = new ExtensionBridge(pipeAuth);
    await bridge.start();
    console.log('[reach] Extension bridge: listening on named pipe');
  } catch (err) {
    // If generatePipeAuth() succeeded but bridge.start() threw, the auth file
    // is on disk but no listener is active.  Clean it up so the extension
    // doesn't try to connect to a dead pipe on the next startup.
    // cleanupPipeAuth() is ENOENT-safe, so it's also harmless if generatePipeAuth
    // itself failed before writing the file.
    await cleanupPipeAuth().catch(() => { /* non-fatal — daemon is failing anyway */ });
    console.warn(
      '[reach] Extension bridge unavailable — bridge sessions disabled:',
      err instanceof Error ? err.message : String(err),
    );
    bridge = null;
  }

  const sdkFactory = new CopilotClientImpl(model, permissionPolicy);
  // Composite factory: bridge-first, SDK-fallback (Option A — see decisions inbox).
  // AllowAlwaysStore is created fresh per BridgeSession by the factory (ADR-9 Q2 — per-session).
  const factory: CopilotSessionFactory = bridge
    ? new CompositeSessionFactory(new BridgeSessionFactory(bridge), sdkFactory)
    : sdkFactory;

  await registry.load();

  const bot = createBot(token, chatId);
  if (allowedUserIdSet === undefined) {
    console.warn('[reach] ⚠️  TELEGRAM_ALLOWED_USER_IDS not configured — relying on chat ID guard only for AFK input');
  }
  if (permissionPolicy === 'approveAll') {
    console.warn('[reach] REACH_PERMISSION_POLICY=approveAll; AFK mirror input from Telegram will be blocked for safety. Use interactiveDestructive for remote input.');
  }

  const afkMode = bridge
    ? new AfkModeController(bot, bridge, registry, chatId, undefined, {
      ...(allowedUserIdSet !== undefined && { allowedUserIds: allowedUserIdSet }),
      allowTelegramInput: permissionPolicy !== 'approveAll',
    })
    : undefined;

  const relay = registerHandlers({
    bot,
    registry,
    factory,
    globalModel: model,
    permissionPolicy,
    ...(afkMode !== undefined && { telegramMirror: afkMode }),
  });

  console.log(`[reach] Model: ${model}`);
  console.log(`[reach] Permission policy: ${permissionPolicy}`);
  console.log(`[reach] Registry: ${registryPath}`);
  console.log(`[reach] Allowed chat: ***${String(chatId).slice(-4)}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[reach] Shutting down…');
    relay.dispose();
    const tasks: Promise<unknown>[] = [bot.stop(), sdkFactory.stop()];
    if (bridge) tasks.push(bridge.stop());
    Promise.allSettled(tasks).finally(() => {
      console.log('[reach] Bye.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[reach] Bot started. Listening for messages…');
  // Explicit allowed_updates: grammY's auto-inference from registered handlers
  // can race with the Telegram-side sticky setting from a prior bot instance.
  // Listing the update kinds we care about avoids "buttons do nothing" bugs.
  await bot.start({
    allowed_updates: ['message', 'edited_message', 'callback_query'],
  });
}

main().catch((err) => {
  console.error('[reach] Fatal:', err);
  process.exit(1);
});
