/**
 * Persistent configuration for Reach.
 *
 * Stores pairing codes (telegramChatId) after /pair completes.
 * Platform-aware storage:
 *   - Windows: %APPDATA%\reach\config.json
 *   - Unix:    ~/.config/reach/config.json
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface ReachConfig {
  telegramChatId?: number;
}

export function getConfigPath(): string {
  if (os.platform() === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'reach', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'reach', 'config.json');
}

export async function loadConfig(configPath: string): Promise<ReachConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as ReachConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(configPath: string, config: ReachConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = configPath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
  await fs.rename(tmp, configPath);
}
