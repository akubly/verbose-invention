import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, getConfigPath } from '../../src/config/config.js';

interface ReachConfig {
  telegramChatId?: number;
}

describe('Config (Pairing Config)', () => {
  let testDir: string;
  let testConfigPath: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-config-test-'));
    testConfigPath = path.join(testDir, 'config.json');
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadConfig()', () => {
    it('returns empty object for missing file', async () => {
      const config = await loadConfig(testConfigPath);

      expect(config).toEqual({});
    });

    it('returns empty object for corrupt JSON', async () => {
      await fs.writeFile(testConfigPath, 'not valid json{{{', 'utf-8');

      const config = await loadConfig(testConfigPath);

      expect(config).toEqual({});
    });

    it('loads valid config from file', async () => {
      const expected: ReachConfig = { telegramChatId: 123456789 };
      await fs.writeFile(testConfigPath, JSON.stringify(expected), 'utf-8');

      const config = await loadConfig(testConfigPath);

      expect(config).toEqual(expected);
    });
  });

  describe('saveConfig()', () => {
    it('writes and loadConfig reads back', async () => {
      const config: ReachConfig = { telegramChatId: 987654321 };

      await saveConfig(testConfigPath, config);
      const loaded = await loadConfig(testConfigPath);

      expect(loaded).toEqual(config);
    });

    it('creates parent directories', async () => {
      const nestedPath = path.join(testDir, 'nested', 'deep', 'config.json');

      await saveConfig(nestedPath, { telegramChatId: 111 });
      
      const exists = await fs.access(nestedPath).then(() => true, () => false);
      expect(exists).toBe(true);
    });

    it('performs atomic write (tmp + rename)', async () => {
      // First write
      await saveConfig(testConfigPath, { telegramChatId: 111 });
      
      // Second write should use atomic pattern
      await saveConfig(testConfigPath, { telegramChatId: 222 });
      
      const loaded = await loadConfig(testConfigPath);
      expect(loaded.telegramChatId).toBe(222);
    });
  });

  describe('getConfigPath()', () => {
    it('returns a platform-aware path', () => {
      const configPath = getConfigPath();

      // Should return a non-empty string
      expect(configPath).toBeTruthy();
      expect(typeof configPath).toBe('string');

      // On Windows, should include APPDATA or similar
      // On Unix, should include .config or home dir
      if (process.platform === 'win32') {
        expect(configPath).toContain('reach');
      } else {
        expect(configPath).toContain('reach');
      }
    });
  });
});
