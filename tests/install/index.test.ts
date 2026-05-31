/**
 * Tests for src/install/index.ts (runInit orchestrator + config wizard)
 *
 * Contract under test (Aaron's decisions + .copilot/reach-install-handoff.md):
 *   - All three env vars set → wizard prints ✅, no prompts, runs copyExtension + service install
 *   - TELEGRAM_BOT_TOKEN missing + TTY → prompts, writes to .env
 *   - TELEGRAM_BOT_TOKEN missing + empty answer → exit(1)
 *   - .env absent → wizard creates it (writeFileSync called)
 *   - .env exists with other keys → keys preserved after write
 *   - TELEGRAM_ALLOWED_USER_IDS missing → prompts; user provides → written to .env
 *   - TELEGRAM_ALLOWED_USER_IDS missing → user blanks → [y/N] skip confirmation
 *       y → warns about fatal-exit, continues
 *       n → exit(1)
 *   - TELEGRAM_CHAT_ID missing → warn only, no readline prompt
 *   - Non-TTY + required vars missing → exit(1) with instructions, readline never called
 *   - Non-TTY + all vars present → proceeds normally (no TTY needed)
 *   - Secrets never written outside .env
 *   - copyExtension() and service install called on happy path
 *
 * Implementation status: Carter's index.ts is fully implemented.
 * These tests should be GREEN against the current implementation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as path from 'path';

// ─── Hoisted state shared between vi.mock factories ───────────────────────────
// vi.mock factories are hoisted before variable declarations, so shared state
// must be established with vi.hoisted() first.

const { rlAnswerQueue, mockCreateInterface } = vi.hoisted(() => ({
  rlAnswerQueue:        [] as string[],
  mockCreateInterface:  vi.fn(),
}));

// ─── Mock readline ────────────────────────────────────────────────────────────

vi.mock('readline', () => ({
  createInterface: (...args: unknown[]) => {
    mockCreateInterface(...args);
    return {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
        cb(rlAnswerQueue.shift() ?? '');
      }),
      close: vi.fn(),
    };
  },
}));

// ─── Mock fs ─────────────────────────────────────────────────────────────────

const mockExistsSync    = vi.fn<[unknown], boolean>(() => false);
const mockReadFileSync  = vi.fn<[unknown, unknown?], string>(() => '');
const mockWriteFileSync = vi.fn<[unknown, unknown, unknown?], void>(() => undefined);

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync:    (...args: unknown[]) => mockExistsSync(...args),
    readFileSync:  (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

// ─── Mock copyExtension (local module) ────────────────────────────────────────

const mockCopyExtension = vi.fn<[], void>(() => undefined);

vi.mock('../../src/install/copyExtension.js', () => ({
  copyExtension: () => mockCopyExtension(),
}));

// ─── Mock service installer ───────────────────────────────────────────────────

const mockServiceInstall = vi.fn<[], Promise<void>>(() => Promise.resolve());

vi.mock('../../src/service/install.js', () => ({
  install:             (...args: unknown[]) => mockServiceInstall(...args as []),
  uninstall:           vi.fn(),
  createService:       vi.fn(),
  resolveCurrentUser:  vi.fn(() => ({ username: 'TestUser', domain: 'TESTDOMAIN' })),
  promptPassword:      vi.fn(() => Promise.resolve('test-pass')),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { runInit } from '../../src/install/index.js';

// ─── Stable path constants ────────────────────────────────────────────────────

const ENV_PATH = path.join(process.cwd(), '.env');

// ─── Spies ────────────────────────────────────────────────────────────────────

let mockExit:         ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
let mockConsoleLog:   ReturnType<typeof vi.spyOn<typeof console, 'log'>>;
let mockConsoleError: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
let mockConsoleWarn:  ReturnType<typeof vi.spyOn<typeof console, 'warn'>>;

let savedTTY: boolean | undefined;
let savedEnv: Record<string, string | undefined>;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('runInit() — orchestrator + config wizard', () => {
  beforeAll(() => {
    mockExit        = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockConsoleLog  = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError= vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    savedTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  });

  beforeEach(() => {
    savedEnv = {
      TELEGRAM_BOT_TOKEN:         process.env['TELEGRAM_BOT_TOKEN'],
      TELEGRAM_CHAT_ID:           process.env['TELEGRAM_CHAT_ID'],
      TELEGRAM_ALLOWED_USER_IDS:  process.env['TELEGRAM_ALLOWED_USER_IDS'],
    };
    // Default: happy path — all required vars present, .env absent (not needed).
    process.env['TELEGRAM_BOT_TOKEN']        = 'test-bot-token';
    process.env['TELEGRAM_CHAT_ID']          = '12345';
    process.env['TELEGRAM_ALLOWED_USER_IDS'] = '111222';
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    vi.clearAllMocks();
    // Re-establish mocks cleared by clearAllMocks.
    mockExit.mockImplementation((code?: number) => { throw new Error(`process.exit(${code})`); });
    mockConsoleLog.mockImplementation(() => {});
    mockConsoleError.mockImplementation(() => {});
    mockConsoleWarn.mockImplementation(() => {});
    mockCopyExtension.mockImplementation(() => undefined);
    mockServiceInstall.mockImplementation(() => Promise.resolve());

    // Default fs: no .env file.
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockWriteFileSync.mockImplementation(() => undefined);

    // Reset readline queue.
    rlAnswerQueue.length = 0;
    mockCreateInterface.mockClear();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: savedTTY });
  });

  // ── IX1: Happy path — all vars set ────────────────────────────────────────

  it('IX1 all vars set: wizard prints ✅ for each, no readline prompts fired', async () => {
    await runInit();

    // No interactive prompts should have been opened.
    expect(mockCreateInterface).not.toHaveBeenCalled();

    // Should log "found" status for all three vars.
    const logOutput = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]) => String(m)).join('\n');
    expect(logOutput).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(logOutput).toMatch(/TELEGRAM_ALLOWED_USER_IDS/);
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── IX2: copyExtension + service install called on happy path ─────────────

  it('IX2 happy path: calls copyExtension() and service install()', async () => {
    await runInit();

    expect(mockCopyExtension).toHaveBeenCalledOnce();
    expect(mockServiceInstall).toHaveBeenCalledOnce();
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── IX3: TELEGRAM_BOT_TOKEN missing → prompt, write to .env ──────────────

  it('IX3 BOT_TOKEN missing + TTY: prompts and writes token to .env', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    rlAnswerQueue.push('my-new-bot-token');

    await runInit();

    expect(mockCreateInterface).toHaveBeenCalled();
    // writeFileSync should have been called with the token line.
    const writes = mockWriteFileSync.mock.calls;
    const writtenContent = writes.map(([, content]) => String(content)).join('');
    expect(writtenContent).toContain('TELEGRAM_BOT_TOKEN=my-new-bot-token');
  });

  // ── IX4: BOT_TOKEN missing + empty prompt answer → exit(1) ───────────────

  it('IX4 BOT_TOKEN missing + empty answer: exits 1', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    rlAnswerQueue.push('');  // empty answer

    await expect(runInit()).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockCopyExtension).not.toHaveBeenCalled();
  });

  // ── IX5: .env absent → wizard creates it with the new key ────────────────

  it('IX5 .env absent: writeFileSync creates file with prompted token', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    mockExistsSync.mockReturnValue(false);  // no .env
    rlAnswerQueue.push('brand-new-token');

    await runInit();

    const [writePath, writeContent] = mockWriteFileSync.mock.calls[0] ?? [];
    expect(String(writePath)).toBe(ENV_PATH);
    expect(String(writeContent)).toContain('TELEGRAM_BOT_TOKEN=brand-new-token');
  });

  // ── IX6: .env exists with other keys → keys preserved after write ─────────

  it('IX6 .env existing keys preserved: existing entries not clobbered when writing new key', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('REACH_MODEL=gpt-4\nTELEGRAM_CHAT_ID=12345\n');
    rlAnswerQueue.push('fresh-token');

    await runInit();

    const writtenContent = mockWriteFileSync.mock.calls
      .map(([, content]) => String(content)).join('');
    expect(writtenContent).toContain('REACH_MODEL=gpt-4');
    expect(writtenContent).toContain('TELEGRAM_BOT_TOKEN=fresh-token');
  });

  // ── IX7: ALLOWED_USER_IDS missing → user provides → written to .env ───────

  it('IX7 ALLOWED_USER_IDS missing: user provides ID → written to .env', async () => {
    delete process.env['TELEGRAM_ALLOWED_USER_IDS'];
    rlAnswerQueue.push('987654');  // answer for allowed IDs prompt

    await runInit();

    const writtenContent = mockWriteFileSync.mock.calls
      .map(([, content]) => String(content)).join('');
    expect(writtenContent).toContain('TELEGRAM_ALLOWED_USER_IDS=987654');
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── IX8: ALLOWED_USER_IDS missing → skip → confirm → warns, continues ─────

  it('IX8 ALLOWED_USER_IDS skipped via y/N → warns about fatal-exit, continues', async () => {
    delete process.env['TELEGRAM_ALLOWED_USER_IDS'];
    rlAnswerQueue.push('');   // blank answer for IDs prompt → triggers skip confirmation
    rlAnswerQueue.push('y');  // confirms skip

    await runInit();

    expect(mockExit).not.toHaveBeenCalled();
    const logOutput = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]) => String(m)).join('\n');
    // Should warn that daemon will refuse requests.
    expect(logOutput).toMatch(/skip|refuse|TELEGRAM_ALLOWED_USER_IDS/i);
    // Should NOT have written an IDs line to .env.
    const writtenContent = mockWriteFileSync.mock.calls
      .map(([, content]) => String(content)).join('');
    expect(writtenContent).not.toContain('TELEGRAM_ALLOWED_USER_IDS');
  });

  // ── IX9: ALLOWED_USER_IDS missing → skip confirmation declined → exit(1) ──

  it('IX9 ALLOWED_USER_IDS skipped but then declined → exits 1', async () => {
    delete process.env['TELEGRAM_ALLOWED_USER_IDS'];
    rlAnswerQueue.push('');   // blank answer for IDs prompt
    rlAnswerQueue.push('n');  // declines skip

    await expect(runInit()).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockCopyExtension).not.toHaveBeenCalled();
  });

  // ── IX10: TELEGRAM_CHAT_ID missing → warns only, no readline prompt ───────

  it('IX10 CHAT_ID missing: warns without opening a readline prompt', async () => {
    delete process.env['TELEGRAM_CHAT_ID'];

    await runInit();

    // No prompts for CHAT_ID — only CHAT_ID-related outputs come from console.log.
    // Verify no readline was opened for chat ID (bot token and allowed IDs are set so
    // no readline needed at all in this test).
    expect(mockCreateInterface).not.toHaveBeenCalled();
    const logOutput = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]) => String(m)).join('\n');
    // Wizard should mention TELEGRAM_CHAT_ID as missing/warn.
    expect(logOutput).toMatch(/TELEGRAM_CHAT_ID/);
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── IX11: Non-TTY + required vars missing → exit(1), readline never called ─

  it('IX11 non-TTY + missing vars: exits 1 with instructions, never calls readline', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    await expect(runInit()).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockCreateInterface).not.toHaveBeenCalled();
    // Error message should mention instructions (set .env or use TTY).
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('.env'),
    );
  });

  // ── IX12: Non-TTY + all vars set → proceeds without prompting ─────────────

  it('IX12 non-TTY + all vars present: proceeds without readline, no exit', async () => {
    // All vars set in beforeEach — just disable TTY.
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    await runInit();

    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockCopyExtension).toHaveBeenCalledOnce();
  });

  // ── IX13: Secrets never written outside .env ──────────────────────────────

  it('IX13 secret hygiene: writeFileSync is only ever called with ENV_PATH', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    rlAnswerQueue.push('secret-token-value');

    await runInit();

    for (const [writePath] of mockWriteFileSync.mock.calls) {
      expect(String(writePath)).toBe(ENV_PATH);
    }
  });
});
