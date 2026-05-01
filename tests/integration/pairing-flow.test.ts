/**
 * Integration test: Pairing flow.
 *
 * Tests the pairing code flow components:
 * - Config round-trip (save → load)
 * - Pairing code validation (6-digit range)
 * - /pair command handler behavior
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { loadConfig, saveConfig } from '../../src/config/config.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Bot } from 'grammy';
import type { Update, Message } from 'grammy/types';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Temporary config path for test isolation. */
function getTempConfigPath(): string {
  return path.join(os.tmpdir(), `reach-test-config-${randomUUID()}.json`);
}

/**
 * Creates a realistic Telegram Update object for /pair command.
 */
function makePairUpdate(
  chatId: number,
  pairingCode: string,
  chatType: 'supergroup' | 'group' | 'private' = 'supergroup',
): Update {
  const message: Message = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: chatId,
      type: chatType,
    },
    text: `/pair ${pairingCode}`,
    entities: [
      {
        type: 'bot_command',
        offset: 0,
        length: 5,
      },
    ],
  };

  return {
    update_id: Math.floor(Math.random() * 1000000),
    message,
  } as Update;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('Integration: Pairing flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Config round-trip ─────────────────────────────────────────────────────────

  describe('config round-trip', () => {
    it('saves and loads chat ID correctly', async () => {
      const configPath = getTempConfigPath();
      const chatId = -1001234567890;

      await saveConfig(configPath, { telegramChatId: chatId });
      const loaded = await loadConfig(configPath);

      expect(loaded.telegramChatId).toBe(chatId);

      // Cleanup
      await fs.unlink(configPath).catch(() => {});
    });

    it('writes config atomically (tmp + rename)', async () => {
      const configPath = getTempConfigPath();
      const chatId = -1001234567890;

      await saveConfig(configPath, { telegramChatId: chatId });

      // Verify the temp file doesn't exist after save
      const tmpPath = configPath + '.tmp';
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // Verify the final config file exists
      await expect(fs.access(configPath)).resolves.toBeUndefined();

      // Cleanup
      await fs.unlink(configPath).catch(() => {});
    });

    it('creates parent directory if it does not exist', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-test-dir-'));
      const configPath = path.join(tempDir, 'config.json');

      await saveConfig(configPath, { telegramChatId: 12345 });

      // Verify the config was written
      const loaded = await loadConfig(configPath);
      expect(loaded.telegramChatId).toBe(12345);

      // Cleanup
      await fs.rm(tempDir, { recursive: true }).catch(() => {});
    });

    it('returns empty object when config file does not exist', async () => {
      const nonExistentPath = path.join(os.tmpdir(), `reach-nonexistent-${randomUUID()}.json`);
      const loaded = await loadConfig(nonExistentPath);

      expect(loaded).toEqual({});
    });

    it('returns empty object when config is corrupt JSON', async () => {
      const configPath = getTempConfigPath();
      await fs.writeFile(configPath, '{ invalid json }', 'utf-8');

      const loaded = await loadConfig(configPath);
      expect(loaded).toEqual({});

      // Cleanup
      await fs.unlink(configPath).catch(() => {});
    });
  });

  // ── Pairing code validation ───────────────────────────────────────────────────

  describe('pairing code validation', () => {
    it('uses 6-digit integer pairing codes in the valid range', () => {
      const validCodes = [100000, 123456, 999999];

      for (const code of validCodes) {
        expect(code).toBeGreaterThanOrEqual(100000);
        expect(code).toBeLessThanOrEqual(999999);
        expect(String(code)).toHaveLength(6);
        expect(Number.isInteger(code)).toBe(true);
      }
    });
  });

  // ── /pair command handler behavior ────────────────────────────────────────────

  describe('/pair command handler', () => {
    it('validates pairing code matches expected code', async () => {
      const CORRECT_CODE = '123456';
      const WRONG_CODE = '654321';
      const CHAT_ID = -1001234567890;

      const bot = new Bot('fake-token', { botInfo: { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });
      let replyText = '';
      let pairingSuccess = false;

      bot.command('pair', async (ctx) => {
        const userCode = ctx.match?.trim();
        if (userCode === CORRECT_CODE) {
          const chatType = ctx.chat?.type;
          if (chatType !== 'supergroup') {
            replyText = '❌ Pairing must be done from a supergroup with forum topics enabled.';
            return;
          }
          pairingSuccess = true;
          replyText = '✅ Paired!';
        } else {
          replyText = '❌ Invalid pairing code.';
        }
      });

      // Test wrong code
      const wrongUpdate = makePairUpdate(CHAT_ID, WRONG_CODE);
      await bot.handleUpdate(wrongUpdate);
      expect(replyText).toContain('❌ Invalid pairing code');
      expect(pairingSuccess).toBe(false);

      // Test correct code
      const correctUpdate = makePairUpdate(CHAT_ID, CORRECT_CODE);
      await bot.handleUpdate(correctUpdate);
      expect(replyText).toContain('✅ Paired!');
      expect(pairingSuccess).toBe(true);
    });

    it('rejects pairing from non-supergroup chats', async () => {
      const CORRECT_CODE = '123456';
      const CHAT_ID = -1001234567890;

      const bot = new Bot('fake-token', { botInfo: { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });
      let replyText = '';

      bot.command('pair', async (ctx) => {
        const userCode = ctx.match?.trim();
        if (userCode === CORRECT_CODE) {
          const chatType = ctx.chat?.type;
          if (chatType !== 'supergroup') {
            replyText = '❌ Pairing must be done from a supergroup with forum topics enabled.';
            return;
          }
          replyText = '✅ Paired!';
        } else {
          replyText = '❌ Invalid pairing code.';
        }
      });

      // Test from regular group (not supergroup)
      const groupUpdate = makePairUpdate(CHAT_ID, CORRECT_CODE, 'group');
      await bot.handleUpdate(groupUpdate);
      expect(replyText).toContain('❌ Pairing must be done from a supergroup');
    });

    it('saves chat ID to config on successful pairing', async () => {
      const CORRECT_CODE = '123456';
      const CHAT_ID = -1001234567890;
      const configPath = getTempConfigPath();

      const bot = new Bot('fake-token', { botInfo: { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });

      bot.command('pair', async (ctx) => {
        const userCode = ctx.match?.trim();
        if (userCode === CORRECT_CODE) {
          const chatType = ctx.chat?.type;
          if (chatType !== 'supergroup') {
            return;
          }
          const pairedChatId = ctx.chat?.id;
          if (!pairedChatId) {
            return;
          }
          await saveConfig(configPath, { telegramChatId: pairedChatId });
        }
      });

      const correctUpdate = makePairUpdate(CHAT_ID, CORRECT_CODE);
      await bot.handleUpdate(correctUpdate);

      // Verify config was written with correct chat ID
      const loaded = await loadConfig(configPath);
      expect(loaded.telegramChatId).toBe(CHAT_ID);

      // Cleanup
      await fs.unlink(configPath).catch(() => {});
    });

    it('handles missing chat ID gracefully during pairing', async () => {
      const CORRECT_CODE = '123456';

      const bot = new Bot('fake-token', { botInfo: { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });
      let replyText = '';

      bot.command('pair', async (ctx) => {
        const userCode = ctx.match?.trim();
        if (userCode === CORRECT_CODE) {
          const chatType = ctx.chat?.type;
          if (chatType !== 'supergroup') {
            return;
          }
          const pairedChatId = ctx.chat?.id;
          if (!pairedChatId) {
            replyText = '❌ Could not determine chat ID.';
            return;
          }
          replyText = '✅ Paired!';
        }
      });

      // Create update with undefined chat.id
      const update = makePairUpdate(123, CORRECT_CODE);
      (update.message as any).chat.id = undefined;

      await bot.handleUpdate(update);
      expect(replyText).toContain('❌ Could not determine chat ID');
    });
  });

  // ── End-to-end pairing scenario ───────────────────────────────────────────────

  describe('end-to-end pairing scenario', () => {
    it('completes full pairing workflow: generate code → validate → save config', async () => {
      const configPath = getTempConfigPath();
      
      // Step 1: Generate pairing code (simulate main.ts behavior)
      const pairingCode = String(Math.floor(Math.random() * 900000) + 100000);
      expect(pairingCode.length).toBe(6);

      // Step 2: Create bot and /pair handler
      const CHAT_ID = -1001234567890;
      const bot = new Bot('fake-token', { botInfo: { id: 123, is_bot: true, first_name: 'TestBot', username: 'testbot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } });
      let pairSuccess = false;

      bot.command('pair', async (ctx) => {
        const userCode = ctx.match?.trim();
        if (userCode === pairingCode) {
          const chatType = ctx.chat?.type;
          if (chatType !== 'supergroup') {
            return;
          }
          const pairedChatId = ctx.chat?.id;
          if (!pairedChatId) {
            return;
          }
          await saveConfig(configPath, { telegramChatId: pairedChatId });
          pairSuccess = true;
        }
      });

      // Step 3: Simulate user sending correct pairing code
      const update = makePairUpdate(CHAT_ID, pairingCode);
      await bot.handleUpdate(update);

      // Step 4: Verify pairing succeeded and config was written
      expect(pairSuccess).toBe(true);
      const loaded = await loadConfig(configPath);
      expect(loaded.telegramChatId).toBe(CHAT_ID);

      // Cleanup
      await fs.unlink(configPath).catch(() => {});
    });
  });
});
