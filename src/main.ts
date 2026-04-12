/**
 * Reach — DI root and daemon entry point.
 *
 * Wires the Telegram bot, session registry, and Copilot SDK factory,
 * then starts long-polling. Graceful shutdown on SIGINT/SIGTERM.
 */

import 'dotenv/config';
import * as os from 'os';
import * as path from 'path';
import { createBot } from './bot/index.js';
import { registerHandlers } from './bot/handlers.js';
import { SessionRegistry } from './sessions/registry.js';
import { CopilotClientImpl } from './copilot/impl.js';

function getRegistryPath(): string {
  if (os.platform() === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'reach', 'registry.json');
  }
  return path.join(os.homedir(), '.config', 'reach', 'registry.json');
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[reach] Fatal: TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  const chatId = process.env.TELEGRAM_CHAT_ID
    ? Number(process.env.TELEGRAM_CHAT_ID)
    : undefined;
  const model = process.env.REACH_MODEL ?? 'claude-sonnet-4';
  const registryPath = getRegistryPath();

  const registry = new SessionRegistry(registryPath);
  const factory = new CopilotClientImpl(model);
  const bot = createBot(token, chatId);

  registerHandlers({ bot, registry, factory });

  await registry.load();
  console.log(`[reach] Model: ${model}`);
  console.log(`[reach] Registry: ${registryPath}`);
  if (chatId !== undefined) console.log(`[reach] Allowed chat: ${chatId}`);

  const shutdown = () => {
    console.log('\n[reach] Shutting down…');
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
