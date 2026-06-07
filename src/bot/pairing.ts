/**
 * Pairing mode: run the /pair bot flow to bind a Telegram supergroup chat
 * to this Reach instance, saving the chat ID to config.json.
 */

import * as crypto from 'crypto';
import { Bot } from 'grammy';
import { saveConfig } from '../config/config.js';
import type { EnvConfig } from '../config/env.js';

export async function runPairingMode(cfg: EnvConfig): Promise<void> {
  const pairingCode = String(crypto.randomInt(100000, 1000000));
  console.log(`[reach] No TELEGRAM_CHAT_ID set. Pairing mode active.`);
  console.log(`[reach] Pairing code: ${pairingCode} (expires in 5 minutes)`);

  const pairingBot = new Bot(cfg.token!);
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
      await saveConfig(cfg.configPath, {
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
}
