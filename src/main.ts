/**
 * Reach — DI root and daemon entry point.
 *
 * Wires the channel, session registry, and Copilot SDK factory,
 * then starts the channel. Graceful shutdown on SIGINT/SIGTERM.
 */

import 'dotenv/config';
import { TelegramChannel } from './channel/telegram/index.js'; // side-effect: registers 'telegram' channel factory
import { createChannel } from './channel/registry.js';
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
import { migrateLegacyDataDir } from './config/migrate.js';

export async function main(): Promise<void> {
  // Migrate legacy state dirs on first startup after storage unification.
  migrateLegacyDataDir();

  const cfg = await parseEnv();
  if (cfg.isPairingMode) {
    await runPairingMode(cfg);
    return;
  }

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

  const channel = createChannel(cfg.reachChannel, cfg);

  let afkMode: AfkModeController | undefined;

  // AFK mirror and grammY bot access are Telegram-specific.
  // For non-Telegram channels, skip AFK wiring and log a warning.
  if (channel instanceof TelegramChannel) {
    const bot = channel.bot;
    const chatId = cfg.chatId!; // guaranteed non-undefined for Telegram normal mode

    if (cfg.permissionPolicy === 'approveAll') {
      console.warn('[reach] REACH_PERMISSION_POLICY=approveAll; AFK mirror input from Telegram will be blocked for safety. Use interactiveDestructive for remote input.');
    }

    afkMode = bridge
      ? new AfkModeController(bot, bridge, registry, chatId, undefined, {
        ...(cfg.allowedUserIdSet !== undefined && { allowedUserIds: cfg.allowedUserIdSet }),
        allowTelegramInput: cfg.permissionPolicy !== 'approveAll',
        globalModel: cfg.model,
      })
      : undefined;

    // Wire AFK mirror interception into TelegramChannel before start() registers handlers.
    if (afkMode) {
      channel.setMessageInterceptor((ctx) => afkMode!.handleTelegramMessage(ctx));
    }

    console.log(`[reach] Allowed chat: ***${String(chatId).slice(-4)}`);
  } else {
    console.warn('[reach] AFK mirror currently requires the Telegram transport; skipping AFK wiring.');
  }

  const relay = registerHandlers({
    registry, factory,
    globalModel: cfg.model,
    channel,
    permissionPolicy: cfg.permissionPolicy,
    configPath: cfg.configPath,
    ...(afkMode !== undefined && { statusProvider: afkMode }),
  });

  console.log(`[reach] Channel: ${cfg.reachChannel}`);
  console.log(`[reach] Model: ${cfg.model}`);
  console.log(`[reach] Permission policy: ${cfg.permissionPolicy}`);
  console.log(`[reach] Registry: ${cfg.registryPath}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[reach] Shutting down…');
    relay.dispose();
    const tasks: Promise<unknown>[] = [channel.stop(), sdkFactory.stop()];
    if (bridge) tasks.push(bridge.stop());
    Promise.allSettled(tasks).finally(() => { console.log('[reach] Bye.'); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[reach] Channel starting: ${channel.name}`);
  await channel.start();
  console.log(`[reach] Channel started: ${channel.name}`);
}
