import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, getConfigPath, getReachDataDir, type ReachConfig } from '../../src/config/config.js';

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

  describe('getReachDataDir()', () => {
    const savedEnv = process.env.REACH_DATA_DIR;

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.REACH_DATA_DIR;
      else process.env.REACH_DATA_DIR = savedEnv;
    });

    it('returns ~/.reach by default', () => {
      delete process.env.REACH_DATA_DIR;
      const dataDir = getReachDataDir();
      expect(dataDir).toBe(path.join(os.homedir(), '.reach'));
    });

    it('honors REACH_DATA_DIR absolute override', () => {
      process.env.REACH_DATA_DIR = '/custom/reach/dir';
      const dataDir = getReachDataDir();
      expect(dataDir).toBe(path.resolve('/custom/reach/dir'));
    });

    it('ignores REACH_DATA_DIR when set to empty string', () => {
      process.env.REACH_DATA_DIR = '';
      const dataDir = getReachDataDir();
      expect(dataDir).toBe(path.join(os.homedir(), '.reach'));
    });

    it('ignores REACH_DATA_DIR when set to whitespace only', () => {
      process.env.REACH_DATA_DIR = '   ';
      const dataDir = getReachDataDir();
      expect(dataDir).toBe(path.join(os.homedir(), '.reach'));
    });

    it('resolves relative REACH_DATA_DIR to absolute via path.resolve', () => {
      process.env.REACH_DATA_DIR = 'relative/path';
      const dataDir = getReachDataDir();
      expect(path.isAbsolute(dataDir)).toBe(true);
      expect(dataDir).toBe(path.resolve('relative/path'));
    });
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
    it('returns <dataDir>/config.json', () => {
      const configPath = getConfigPath();
      expect(configPath).toBe(path.join(getReachDataDir(), 'config.json'));
    });

    it('getConfigPath() uses REACH_DATA_DIR override when set', () => {
      const saved = process.env.REACH_DATA_DIR;
      try {
        process.env.REACH_DATA_DIR = path.join(os.tmpdir(), 'reach-test-override');
        const configPath = getConfigPath();
        expect(configPath).toBe(path.join(path.resolve(process.env.REACH_DATA_DIR), 'config.json'));
      } finally {
        if (saved === undefined) delete process.env.REACH_DATA_DIR;
        else process.env.REACH_DATA_DIR = saved;
      }
    });
  });
});
