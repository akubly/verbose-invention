/**
 * R1 — Telegram factory reads credentials from EnvConfig, not process.env directly.
 *
 * REGRESSION CONTEXT: Before Carter's cycle-1 fix (commit 58e1326) the factory was:
 *   registerChannel('telegram', () =>
 *     new TelegramChannel(
 *       new Bot(process.env.TELEGRAM_BOT_TOKEN!),
 *       Number(process.env.TELEGRAM_CHAT_ID) || 0,
 *     )
 *   );
 *
 * With TELEGRAM_CHAT_ID unset in env but config.json supplying chatId=99999:
 *   - parseEnv() correctly resolved cfg.chatId = 99999 from config.json
 *   - BUT the factory ignored cfg entirely and did Number(undefined) || 0 → 0
 *   - TelegramChannel was constructed with allowedChatId = 0 (WRONG)
 *   - Every message was silently filtered out — the daemon appeared to start
 *     but responded to nothing.
 *
 * Post-fix factory reads cfg.token and cfg.chatId from the already-resolved
 * EnvConfig, so paired-config installs (creds in config.json, env unset)
 * work correctly.
 *
 * CONFIRMATION: Test R1a below would FAIL against the pre-fix factory because
 * the pre-fix code ignores cfg.chatId and returns 0 when TELEGRAM_CHAT_ID is
 * unset in env. allowedChatId would be 0, not 99999.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnvConfig } from '../../../src/config/env.js';

// Must be hoisted before telegram/index.js is imported so the factory sees
// the mocked Bot constructor (no real network connection attempt).
vi.mock('grammy', () => {
  const MockBot = vi.fn().mockImplementation(() => ({
    use: vi.fn(),
    on: vi.fn(),
    command: vi.fn(),
    catch: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      createForumTopic: vi.fn(),
    },
  }));
  return { Bot: MockBot };
});

// Importing telegram/index.js has the side effect of registering the 'telegram'
// factory via registerChannel(). Each test file runs in an isolated module
// context so there is no double-registration conflict with other test files.
import { Bot } from 'grammy';
import { createChannel } from '../../../src/channel/registry.js';
import { TelegramChannel } from '../../../src/channel/telegram/index.js';

function makeBaseCfg(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    token: 'cfg-token',
    chatId: 99999,
    isPairingMode: false,
    model: 'claude-sonnet-4',
    permissionPolicy: 'approveAll',
    allowedUserIdSet: undefined,
    configPath: 'C:\\fake\\config.json',
    registryPath: 'C:\\fake\\data\\registry.json',
    reachChannel: 'telegram',
    ...overrides,
  };
}

describe('R1 — Telegram factory reads credentials from EnvConfig (not process.env)', () => {
  beforeEach(() => {
    vi.mocked(Bot).mockClear();
    // Ensure env vars are UNSET so we can prove the factory ignores them.
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('R1a: constructs TelegramChannel with allowedChatId from cfg.chatId when TELEGRAM_CHAT_ID env is unset', () => {
    // TELEGRAM_CHAT_ID is unset (deleted in beforeEach).
    //
    // Pre-fix factory: Number(process.env.TELEGRAM_CHAT_ID) || 0 → 0
    //   allowedChatId would be 0 — THIS TEST WOULD HAVE FAILED PRE-FIX.
    //
    // Post-fix factory: cfg.chatId ?? 0 → 99999
    const cfg = makeBaseCfg({ chatId: 99999 });

    const channel = createChannel('telegram', cfg);

    expect(channel).toBeInstanceOf(TelegramChannel);
    // Access the private allowedChatId to confirm the factory passed cfg.chatId,
    // not the env-derived 0.
    expect((channel as unknown as { allowedChatId: number }).allowedChatId).toBe(99999);
  });

  it('R1b: constructs TelegramChannel with cfg.token when TELEGRAM_BOT_TOKEN env is unset', () => {
    // TELEGRAM_BOT_TOKEN is unset (deleted in beforeEach).
    //
    // Pre-fix factory: new Bot(process.env.TELEGRAM_BOT_TOKEN!) → Bot(undefined)
    // Post-fix factory: new Bot(cfg.token) → Bot('cfg-only-token')
    const cfg = makeBaseCfg({ token: 'cfg-only-token', chatId: 12345 });

    createChannel('telegram', cfg);

    // Bot constructor was called with the config-provided token, not undefined.
    expect(vi.mocked(Bot)).toHaveBeenCalledWith('cfg-only-token');
  });

  it('R1c: different cfg.chatId values produce TelegramChannels with the correct allowedChatId', () => {
    // Parameterized sanity check: each call gets its own chatId value.
    delete process.env.TELEGRAM_CHAT_ID;

    const ch1 = createChannel('telegram', makeBaseCfg({ chatId: 111 }));
    const ch2 = createChannel('telegram', makeBaseCfg({ chatId: 222222 }));
    const ch3 = createChannel('telegram', makeBaseCfg({ chatId: -1001234567890 }));

    expect((ch1 as unknown as { allowedChatId: number }).allowedChatId).toBe(111);
    expect((ch2 as unknown as { allowedChatId: number }).allowedChatId).toBe(222222);
    expect((ch3 as unknown as { allowedChatId: number }).allowedChatId).toBe(-1001234567890);
  });

  it('R1d: throws if cfg.token is undefined (Telegram requires a token)', () => {
    const cfg = makeBaseCfg({ token: undefined });
    expect(() => createChannel('telegram', cfg)).toThrow('TELEGRAM_BOT_TOKEN is required');
  });

  it('R1e: throws if cfg.chatId is undefined (silent dead-default of 0 is disallowed)', () => {
    // Pre-fix: cfg.chatId ?? 0 → 0; TelegramChannel would start but silently drop all messages.
    // Post-fix: factory throws fast with a clear error so misconfigured daemons fail at startup.
    const cfg = makeBaseCfg({ chatId: undefined });
    expect(() => createChannel('telegram', cfg)).toThrow('chatId is required');
  });
});
