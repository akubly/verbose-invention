/**
 * Transport registry — maps REACH_CHANNEL values to adapter factory functions.
 *
 * Startup-only selection: the DI root (main.ts) calls createChannel() once at
 * boot. There is no runtime hot-swap — changing transport requires a daemon
 * restart. This is intentional; a personal daemon restart is cheap.
 *
 * Usage (in main.ts, after P1-2..P1-6 refactor):
 *
 *   import './channel/telegram/index.js'; // side-effect: registers 'telegram'
 *   import './channel/teams/index.js';    // side-effect: registers 'teams'
 *   const channel = createChannel(process.env.REACH_CHANNEL ?? 'telegram');
 *   await channel.start();
 *
 * Adding a new transport:
 *   1. Implement ChannelPort in src/channel/<name>/index.ts
 *   2. Call registerChannel('<name>', factory) at module scope
 *   3. Import the module in main.ts
 *   4. Run the conformance test kit (P1-7) against the new adapter
 */

import type { ChannelPort } from './port.js';

/**
 * Factory function that creates a ChannelPort instance.
 *
 * The factory receives no arguments — transport-specific config (tokens,
 * tenant IDs, channel IDs) is read from environment variables or config
 * files by the adapter itself, following the existing pattern in
 * src/config/env.ts (TELEGRAM_BOT_TOKEN, etc.).
 */
export type ChannelFactory = () => ChannelPort;

/** Internal registry — populated by registerChannel() calls at import time. */
const registry = new Map<string, ChannelFactory>();

/**
 * Register a transport adapter factory.
 *
 * Called at module scope by each adapter's entry file. The `name` must match
 * the REACH_CHANNEL value that selects this transport (e.g., 'telegram',
 * 'teams', 'slack').
 *
 * @param name    - Transport name (lowercase, kebab-case). Must be unique.
 * @param factory - Factory function that creates the ChannelPort instance.
 * @throws If a transport with the same name is already registered.
 */
export function registerChannel(name: string, factory: ChannelFactory): void {
  if (registry.has(name)) {
    throw new Error(
      `[channel-registry] Transport "${name}" is already registered. ` +
      `Each transport name must be unique.`,
    );
  }
  registry.set(name, factory);
}

/**
 * Create a ChannelPort instance for the given transport name.
 *
 * @param name - Transport name matching a prior registerChannel() call.
 *               Typically sourced from `process.env.REACH_CHANNEL`.
 * @returns A new (not yet started) ChannelPort instance.
 * @throws If no transport is registered under `name`.
 */
export function createChannel(name: string): ChannelPort {
  const factory = registry.get(name);
  if (!factory) {
    const available = Array.from(registry.keys());
    const hint = available.length > 0
      ? ` Available: ${available.join(', ')}.`
      : ' No transports registered — import an adapter module before calling createChannel().';
    throw new Error(
      `[channel-registry] Unknown transport "${name}".${hint} ` +
      `Set REACH_CHANNEL to a registered transport name.`,
    );
  }
  return factory();
}

/**
 * List all registered transport names.
 * Useful for diagnostics, help text, and config validation.
 */
export function listChannels(): readonly string[] {
  return Array.from(registry.keys());
}
