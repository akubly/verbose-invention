/**
 * I4-2 Option A: env-parsing behaviour for TELEGRAM_ALLOWED_USER_IDS.
 *
 * Covers four cases:
 *  1. Empty string  → process.exit(1) + error mentioning misconfiguration
 *  2. Whitespace    → same (trimmed to empty before the check)
 *  3. Unset (undef) → warn mentioning ALL + chatId; daemon continues
 *  4. Valid list    → no ALL-warn, no exit(1); daemon continues to bot.start
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('dotenv/config', () => ({}));

vi.mock('../../src/config/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({})),
  saveConfig: vi.fn(() => Promise.resolve()),
  getConfigPath: vi.fn(() => 'C:\\fake\\config.json'),
  getReachDataDir: vi.fn(() => 'C:\\fake\\data'),
}));

vi.mock('../../src/bot/index.js', () => ({
  createBot: vi.fn(() => ({
    start: vi.fn(() => Promise.reject(new Error('test-sentinel: bot.start'))),
    stop: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('../../src/bot/handlers.js', () => ({
  registerHandlers: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('../../src/sessions/registry.js', () => ({
  SessionRegistry: vi.fn(() => ({
    load: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => []),
  })),
}));

vi.mock('../../src/copilot/impl.js', () => ({
  CopilotClientImpl: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('../../src/bridge/extensionBridge.js', () => ({
  ExtensionBridge: vi.fn(() => ({
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../../src/bot/afkMode.js', () => ({
  AfkModeController: vi.fn(() => ({})),
}));

vi.mock('../../src/bridge/bridgeSessionFactory.js', () => ({
  BridgeSessionFactory: vi.fn(),
}));

vi.mock('../../src/bridge/compositeSessionFactory.js', () => ({
  CompositeSessionFactory: vi.fn(),
}));

vi.mock('../../src/bridge/pipeAuth.js', () => ({
  generatePipeAuth: vi.fn(() => Promise.reject(new Error('test-sentinel: no pipe'))),
  cleanupPipeAuth: vi.fn(() => Promise.resolve()),
}));

import { main } from '../../src/main.js';

describe('main env-parsing (I4-2 Option A)', () => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.REACH_PERMISSION_POLICY;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  });

  it('exits with code 1 when TELEGRAM_ALLOWED_USER_IDS is an empty string', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '';
    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('misconfigur'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when TELEGRAM_ALLOWED_USER_IDS is whitespace-only', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '   ';
    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('misconfigur'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('warns ALL-users when TELEGRAM_ALLOWED_USER_IDS is unset and daemon continues', async () => {
    await expect(main()).rejects.toThrow('test-sentinel: bot.start');
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes('ALL') && msg.includes('12345'))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('does not warn ALL-users when TELEGRAM_ALLOWED_USER_IDS is a valid comma-separated list', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '111,222';
    await expect(main()).rejects.toThrow('test-sentinel: bot.start');
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes('ALL'))).toBe(false);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });
});
