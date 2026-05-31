/**
 * Tests for src/install/uninstall.ts
 *
 * Contract under test (per .copilot/reach-install-handoff.md §Uninstall Design):
 *   1. Stops and uninstalls the Windows service
 *   2. Deletes %APPDATA%\GitHub Copilot\User\extensions\reach\ (extension dir)
 *   3. Does NOT touch %LOCALAPPDATA%\reach\ by default (config/session data preserved)
 *   4. runUninstall({ wipe: true }) ALSO deletes %LOCALAPPDATA%\reach\
 *   5. Without --wipe: prints manual PowerShell command to wipe state
 *   6. Idempotent: succeeds even when dirs do not exist
 *
 * ⚠️  ALL TESTS ARE RED until Carter implements runUninstall() in src/install/uninstall.ts.
 *     The current file is a stub that throws "Not implemented".
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as path from 'path';

// ─── Mock service installer (don't invoke node-windows) ──────────────────────

const mockServiceUninstall = vi.fn<[], void>(() => undefined);

vi.mock('../../src/service/install.js', () => ({
  uninstall:           () => mockServiceUninstall(),
  install:             vi.fn(() => Promise.resolve()),
  createService:       vi.fn(),
  resolveCurrentUser:  vi.fn(() => ({ username: 'TestUser', domain: 'TESTDOMAIN' })),
  promptPassword:      vi.fn(() => Promise.resolve('test-pass')),
}));

// ─── Mock fs ─────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn<[unknown], boolean>(() => false);
const mockRmSync     = vi.fn<[unknown, unknown?], void>(() => undefined);

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    rmSync:     (...args: unknown[]) => mockRmSync(...args),
  };
});

// ─── Import after mocks ───────────────────────────────────────────────────────

import { runUninstall } from '../../src/install/uninstall.js';

// ─── Stable path constants ────────────────────────────────────────────────────

const MOCK_APPDATA       = 'C:\\Users\\Aaron Smith\\AppData\\Roaming';
const MOCK_LOCALAPPDATA  = 'C:\\Users\\Aaron Smith\\AppData\\Local';
const REACH_EXT_DIR      = path.join(MOCK_APPDATA, 'GitHub Copilot', 'User', 'extensions', 'reach');
const REACH_DATA_DIR     = path.join(MOCK_LOCALAPPDATA, 'reach');

// ─── Spies ────────────────────────────────────────────────────────────────────

let mockExit:         ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
let mockConsoleLog:   ReturnType<typeof vi.spyOn<typeof console, 'log'>>;
let mockConsoleError: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;

let savedAppData:      string | undefined;
let savedLocalAppData: string | undefined;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('runUninstall()', () => {
  beforeAll(() => {
    mockExit         = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockConsoleLog   = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  beforeEach(() => {
    savedAppData      = process.env['APPDATA'];
    savedLocalAppData = process.env['LOCALAPPDATA'];
    process.env['APPDATA']      = MOCK_APPDATA;
    process.env['LOCALAPPDATA'] = MOCK_LOCALAPPDATA;

    vi.clearAllMocks();
    mockExit.mockImplementation((code?: number) => { throw new Error(`process.exit(${code})`); });
    mockConsoleLog.mockImplementation(() => {});
    mockConsoleError.mockImplementation(() => {});
    mockServiceUninstall.mockImplementation(() => undefined);

    // Default: both dirs exist (most common "uninstall from clean state" scenario).
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      return p === REACH_EXT_DIR || p === REACH_DATA_DIR;
    });
    mockRmSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedAppData === undefined)      delete process.env['APPDATA'];
    else                                 process.env['APPDATA'] = savedAppData;
    if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
    else                                 process.env['LOCALAPPDATA'] = savedLocalAppData;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // ── UN1: Default (wipe=false) — service + extension, preserve data ────────

  it('UN1 default: calls service uninstall and removes extension dir', () => {
    runUninstall({ wipe: false });

    expect(mockServiceUninstall).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith(
      REACH_EXT_DIR,
      expect.objectContaining({ recursive: true }),
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('UN2 default: does NOT remove LOCALAPPDATA/reach (data preserved)', () => {
    runUninstall({ wipe: false });

    const rmCalls = mockRmSync.mock.calls.map(([p]) => String(p));
    expect(rmCalls.every((p) => p !== REACH_DATA_DIR)).toBe(true);
  });

  it('UN3 default: prints manual PowerShell wipe command', () => {
    runUninstall({ wipe: false });

    const logOutput = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]) => String(msg))
      .join('\n');
    expect(logOutput).toMatch(/Remove-Item/);
    expect(logOutput).toMatch(/LOCALAPPDATA/);
  });

  // ── UN4: wipe=true — also removes data dir ────────────────────────────────

  it('UN4 wipe=true: also removes LOCALAPPDATA/reach', () => {
    runUninstall({ wipe: true });

    expect(mockRmSync).toHaveBeenCalledWith(
      REACH_EXT_DIR,
      expect.objectContaining({ recursive: true }),
    );
    expect(mockRmSync).toHaveBeenCalledWith(
      REACH_DATA_DIR,
      expect.objectContaining({ recursive: true }),
    );
  });

  // ── UN5: Idempotent — extension dir absent ────────────────────────────────

  it('UN5 idempotent: extension dir absent → no rmSync call for ext dir, no error', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      return p === REACH_DATA_DIR;  // only data dir exists
    });

    // Should not throw even if ext dir is absent.
    expect(() => runUninstall({ wipe: false })).not.toThrow();
    const rmCalls = mockRmSync.mock.calls.map(([p]) => String(p));
    expect(rmCalls).not.toContain(REACH_EXT_DIR);
  });

  // ── UN6: Idempotent — neither dir exists ─────────────────────────────────

  it('UN6 idempotent: neither dir exists → succeeds without any rmSync calls', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => runUninstall({ wipe: true })).not.toThrow();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });
});
