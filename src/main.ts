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

  const rawChatId = process.env.TELEGRAM_CHAT_ID;
  if (rawChatId) {
    chatId = Number(rawChatId);
    if (!Number.isInteger(chatId)) {
      console.error('[reach] Fatal: TELEGRAM_CHAT_ID must be a valid integer');
      process.exit(1);
    }
  } else {
    const config = await loadConfig(configPath);
    if (config.telegramChatId) {
      chatId = config.telegramChatId;
      console.log(`[reach] Using chat ID from config: ***${String(chatId).slice(-4)}`);
    }
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
        await saveConfig(configPath, { telegramChatId: pairedChatId });
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
  const factory = new CopilotClientImpl(model, permissionPolicy);
  const bot = createBot(token, chatId);

  const relay = registerHandlers({ bot, registry, factory, globalModel: model });

  await registry.load();
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
    Promise.allSettled([bot.stop(), factory.stop()]).finally(() => {
      console.log('[reach] Bye.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[reach] Bot started. Listening for messages…');
  await bot.start();
}

main().catch((err) => {
  console.error('[reach] Fatal:', err);
  process.exit(1);
});
