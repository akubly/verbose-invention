/**
 * Persistent configuration for Reach.
 *
 * Stores paired Telegram chat ID after /pair completes.
 * All state lives under ~/.reach/ (getReachDataDir()).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface KnownCwd {
  alias: string;       // Unique friendly name, e.g. "reach", "scratch"
  path: string;        // Absolute, normalized (path.resolve) path
  addedAt: string;     // ISO-8601 timestamp
  lastUsedAt?: string; // ISO-8601 timestamp, updated when a session starts here
}

export interface ReachConfig {
  telegramChatId?: number;
  telegramAllowedUserIds?: number[];
  knownCwds?: KnownCwd[]; // Optional — old configs without this field load cleanly
}

/**
 * Resolves the Reach state directory. Honors REACH_DATA_DIR if set (for
 * corporate / redirected-home edge cases); otherwise defaults to ~/.reach/.
 * Works identically on Windows, macOS, and Linux because os.homedir()
 * resolves correctly in both interactive and service contexts (per ADR-5 the
 * service runs as the logged-in user account).
 *
 * Added: 2026-05-31 (PR #10 Cycle 3 — Option D storage unification).
 * Migration from %APPDATA%\reach\ and %LOCALAPPDATA%\reach\ is handled by
 * migrateLegacyDataDir() in src/config/migrate.ts — one-shot at install/startup.
 */
export function getReachDataDir(): string {
  const override = process.env.REACH_DATA_DIR;
  if (override && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), '.reach');
}

export function getConfigPath(): string {
  return path.join(getReachDataDir(), 'config.json');
}

export async function loadConfig(configPath: string): Promise<ReachConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as ReachConfig;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (err instanceof SyntaxError) {
      console.warn(`[config] Corrupt config at ${configPath}, ignoring`);
      return {};
    }
    throw err;
  }
}

export async function saveConfig(configPath: string, config: ReachConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = configPath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
  await fs.rename(tmp, configPath);
}
