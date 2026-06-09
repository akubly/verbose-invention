/**
 * M5-4: Direct unit tests for parseEnv() from src/config/env.ts.
 *
 * Enabled by Kat's I5-3 extraction of parseEnv into its own module — no need
 * to mock 13 unrelated modules just to reach the env-parsing logic. Tests are
 * faster, more focused, and can exercise return values directly.
 *
 * Covers:
 *  - The original 4 cases from tests/main/env-parsing.test.ts (moved here)
 *  - Adversarial edge cases for TELEGRAM_ALLOWED_USER_IDS parsing
 *  - Config-file path (telegramAllowedUserIds in config.json)
 *  - N2: empty allowedUserIdSet (telegramAllowedUserIds: []) is deny-all and fatals (ADR-11 D3)
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({})),
  getConfigPath: vi.fn(() => 'C:\\fake\\config.json'),
  getReachDataDir: vi.fn(() => 'C:\\fake\\data'),
}));

import { parseEnv } from '../../src/config/env.js';
import { loadConfig } from '../../src/config/config.js';

describe('parseEnv (I4-2 / M5-4)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    process.env.REACH_PERMISSION_POLICY = 'interactiveDestructive';
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    // Reset loadConfig mock between tests so per-test overrides don't bleed.
    vi.mocked(loadConfig).mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.REACH_PERMISSION_POLICY;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  });

  // ── Original 4 cases (moved from tests/main/env-parsing.test.ts) ─────────────

  it('exits with code 1 when TELEGRAM_ALLOWED_USER_IDS is an empty string', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('misconfigur'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when TELEGRAM_ALLOWED_USER_IDS is whitespace-only', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '   ';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('misconfigur'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('warns ALL-users when TELEGRAM_ALLOWED_USER_IDS is unset and returns undefined allowedUserIdSet', async () => {
    const result = await parseEnv();
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes('ALL') && msg.includes('12345'))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(result.allowedUserIdSet).toBeUndefined();
  });

  it('does not warn ALL-users and parses Set when TELEGRAM_ALLOWED_USER_IDS is a valid comma-separated list', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '111,222';
    const result = await parseEnv();
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes('ALL'))).toBe(false);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(result.allowedUserIdSet).toEqual(new Set([111, 222]));
  });

  // ── Adversarial edge cases (M5-4 additions) ───────────────────────────────────

  // N2 env-var variant: comma-only value produces all-empty tokens → fatal.
  // TELEGRAM_ALLOWED_USER_IDS="," trims to "," (length > 0, passes the empty-string guard),
  // then split(',') yields ["",""] — each token has length 0 → triggers the positive-integer
  // fatal path. This is distinct from the shipped N2 guard test below which covers the config-JSON
  // empty-array case.
  it('N2 env-var: exits with code 1 when TELEGRAM_ALLOWED_USER_IDS is comma-only (all tokens empty after split)', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = ',';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('positive integer'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 for embedded empty token — "123,,456"', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '123,,456';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('positive integer'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 for non-numeric ID — "abc,123"', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = 'abc,123';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 for zero ID — "0,123"', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '0,123';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 for negative ID — "-1,123"', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '-1,123';
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('parses whitespace-padded IDs successfully — "  123 , 456  "', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '  123 , 456  ';
    const result = await parseEnv();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(result.allowedUserIdSet).toEqual(new Set([123, 456]));
  });

  // ── Config-file path (telegramAllowedUserIds in config.json) ─────────────────

  it('loads allowedUserIdSet from config-file telegramAllowedUserIds when env var is unset', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({ telegramAllowedUserIds: [123, 456] });
    const result = await parseEnv();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(result.allowedUserIdSet).toEqual(new Set([123, 456]));
    // ALL-users warn is suppressed because allowedUserIdSet is defined.
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes('ALL'))).toBe(false);
  });

  it('exits with code 1 for invalid config telegramAllowedUserIds (non-integer)', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({ telegramAllowedUserIds: ['not-a-number'] as unknown as number[] });
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // N2: telegramAllowedUserIds: [] is deny-all and must fatal (ADR-11 D3).
  it('N2: exits with code 1 when config telegramAllowedUserIds is an empty array (deny-all guard)', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({ telegramAllowedUserIds: [] });
    await expect(parseEnv()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('deny all users'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── config.telegramChatId validation (PR #11 round-3 Thread 3) ───────────────

  describe('config.telegramChatId validation', () => {
    beforeEach(() => {
      // Clear env-var path so the config path is exercised.
      delete process.env.TELEGRAM_CHAT_ID;
    });

    it('C1: accepts a valid integer config.telegramChatId and returns it as chatId', async () => {
      vi.mocked(loadConfig).mockResolvedValueOnce({ telegramChatId: 99999 });
      const result = await parseEnv();
      expect(exitSpy).not.toHaveBeenCalledWith(1);
      expect(result.chatId).toBe(99999);
    });

    it('C2: rejects non-integer config.telegramChatId (e.g. 123.45) with process.exit(1)', async () => {
      vi.mocked(loadConfig).mockResolvedValueOnce({ telegramChatId: 123.45 });
      await expect(parseEnv()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('non-zero integer'));
    });

    it('C3: rejects zero config.telegramChatId with process.exit(1)', async () => {
      vi.mocked(loadConfig).mockResolvedValueOnce({ telegramChatId: 0 });
      await expect(parseEnv()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('non-zero integer'));
    });

    it('C4: absent config.telegramChatId (undefined) falls through to pairing mode', async () => {
      vi.mocked(loadConfig).mockResolvedValueOnce({});
      const result = await parseEnv();
      expect(exitSpy).not.toHaveBeenCalledWith(1);
      expect(result.chatId).toBeUndefined();
      expect(result.isPairingMode).toBe(true);
    });
  });
});
