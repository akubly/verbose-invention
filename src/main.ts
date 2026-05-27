/**
 * Reach — DI root and daemon entry point.
 *
 * Wires the Telegram bot, session registry, and Copilot SDK factory,
 * then starts long-polling. Graceful shutdown on SIGINT/SIGTERM.
 */

import 'dotenv/config';
import { createBot } from './bot/index.js';
import { registerHandlers } from './bot/handlers.js';
import { SessionRegistry } from './sessions/registry.js';
import { CopilotClientImpl } from './copilot/impl.js';
import { ExtensionBridge } from './bridge/extensionBridge.js';
import { AfkModeController } from './bot/afkMode.js';
import { BridgeSessionFactory } from './bridge/bridgeSessionFactory.js';
import { CompositeSessionFactory } from './bridge/compositeSessionFactory.js';
import { generatePipeAuth, cleanupPipeAuth } from './bridge/pipeAuth.js';
import type { CopilotSessionFactory } from './copilot/factory.js';
import { parseEnv } from './config/env.js';
import { runPairingMode } from './bot/pairing.js';

export async function main(): Promise<void> {
  const cfg = await parseEnv();
  if (cfg.isPairingMode) {
    await runPairingMode(cfg);
    return;
  }

  const chatId = cfg.chatId!; // guaranteed by isPairingMode === false above
  const registry = new SessionRegistry(cfg.registryPath);

  let bridge: ExtensionBridge | null = null;
  try {
    const pipeAuth = await generatePipeAuth();
    bridge = new ExtensionBridge(pipeAuth);
    await bridge.start();
    console.log('[reach] Extension bridge: listening on named pipe');
  } catch (err) {
    await cleanupPipeAuth().catch(() => { /* non-fatal — daemon is failing anyway */ });
    console.warn(
      '[reach] Extension bridge unavailable — bridge sessions disabled:',
      err instanceof Error ? err.message : String(err),
    );
    bridge = null;
  }

  const sdkFactory = new CopilotClientImpl(cfg.model, cfg.permissionPolicy);
  const factory: CopilotSessionFactory = bridge
    ? new CompositeSessionFactory(new BridgeSessionFactory(bridge), sdkFactory)
    : sdkFactory;

  await registry.load();

  const bot = createBot(cfg.token, chatId);
  if (cfg.permissionPolicy === 'approveAll') {
    console.warn('[reach] REACH_PERMISSION_POLICY=approveAll; AFK mirror input from Telegram will be blocked for safety. Use interactiveDestructive for remote input.');
  }

  const afkMode = bridge
    ? new AfkModeController(bot, bridge, registry, chatId, undefined, {
      ...(cfg.allowedUserIdSet !== undefined && { allowedUserIds: cfg.allowedUserIdSet }),
      allowTelegramInput: cfg.permissionPolicy !== 'approveAll',
    })
    : undefined;

  const relay = registerHandlers({
    bot, registry, factory,
    globalModel: cfg.model,
    permissionPolicy: cfg.permissionPolicy,
    ...(afkMode !== undefined && { telegramMirror: afkMode }),
  });

  console.log(`[reach] Model: ${cfg.model}`);
  console.log(`[reach] Permission policy: ${cfg.permissionPolicy}`);
  console.log(`[reach] Registry: ${cfg.registryPath}`);
  console.log(`[reach] Allowed chat: ***${String(chatId).slice(-4)}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[reach] Shutting down…');
    relay.dispose();
    const tasks: Promise<unknown>[] = [bot.stop(), sdkFactory.stop()];
    if (bridge) tasks.push(bridge.stop());
    Promise.allSettled(tasks).finally(() => { console.log('[reach] Bye.'); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[reach] Bot started. Listening for messages…');
  await bot.start({ allowed_updates: ['message', 'edited_message', 'callback_query'] });
}
