/**
 * Tests for src/install/uninstall.ts
 *
 * Contract under test (post PR #10 Cycle 3 storage unification):
 *   1. Stops and uninstalls the Windows service
 *   2. Deletes %APPDATA%\GitHub Copilot\User\extensions\reach\ (extension dir)
 *   3. Does NOT touch ~/.reach/ by default (config/session data preserved)
 *   4. runUninstall({ wipe: true }) ALSO deletes ~/.reach/ (via getReachDataDir())
 *   5. Without --wipe: prints manual Remove-Item command referencing ~/.reach
 *   6. Idempotent: succeeds even when dirs do not exist
 *   7. wipe only touches the resolved data dir — nothing outside it
 *
 * getReachDataDir() is pinned via process.env.REACH_DATA_DIR in beforeEach
 * so tests are deterministic regardless of the test machine's home dir.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as path from 'path';

// ─── Mock service installer (don't invoke node-windows) ──────────────────────

const mockServiceUninstall = vi.fn<[], Promise<void>>(() => Promise.resolve());

vi.mock('../../src/service/install.js', () => ({
  uninstallService:    () => mockServiceUninstall(),
  uninstall:           vi.fn(() => undefined),
  install:             vi.fn(() => Promise.resolve()),
  createService:       vi.fn(),
  resolveCurrentUser:  vi.fn(() => ({ username: 'TestUser', domain: 'TESTDOMAIN' })),
  promptPassword:      vi.fn(() => Promise.resolve('test-pass')),
}));

// ─── Mock fs ─────────────────────────────────────────────────────────────────

const mockExistsSync    = vi.fn<[unknown], boolean>(() => false);
const mockRmSync        = vi.fn<[unknown, unknown?], void>(() => undefined);
const mockReaddirSync   = vi.fn<[unknown], string[]>(() => ['config.json', 'bridge-auth.json']);

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync:   (...args: unknown[]) => mockExistsSync(...args),
    rmSync:       (...args: unknown[]) => mockRmSync(...args),
    readdirSync:  (...args: unknown[]) => mockReaddirSync(...args),
  };
});

// ─── Import after mocks ───────────────────────────────────────────────────────

import { runUninstall } from '../../src/install/uninstall.js';

// ─── Stable path constants ────────────────────────────────────────────────────

const MOCK_APPDATA      = 'C:\\Users\\Aaron Smith\\AppData\\Roaming';
// Use REACH_DATA_DIR env override so getReachDataDir() returns a deterministic path.
const MOCK_REACH_STATE  = 'C:\\Users\\Aaron Smith\\.reach';
const REACH_EXT_DIR     = path.join(MOCK_APPDATA, 'GitHub Copilot', 'User', 'extensions', 'reach');
// REACH_STATE_DIR is what getReachDataDir() resolves to (via REACH_DATA_DIR env override).
const REACH_STATE_DIR   = MOCK_REACH_STATE;

// ─── Spies ────────────────────────────────────────────────────────────────────

let mockExit:         ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
let mockConsoleLog:   ReturnType<typeof vi.spyOn<typeof console, 'log'>>;
let mockConsoleError: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;

let savedAppData:        string | undefined;
let savedReachDataDir:   string | undefined;

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
    savedAppData       = process.env['APPDATA'];
    savedReachDataDir  = process.env['REACH_DATA_DIR'];
    process.env['APPDATA']        = MOCK_APPDATA;
    // Pin getReachDataDir() to our known test path via the env override.
    process.env['REACH_DATA_DIR'] = MOCK_REACH_STATE;

    vi.clearAllMocks();
    mockExit.mockImplementation((code?: number) => { throw new Error(`process.exit(${code})`); });
    mockConsoleLog.mockImplementation(() => {});
    mockConsoleError.mockImplementation(() => {});
    mockServiceUninstall.mockResolvedValue(undefined);

    // Default: both dirs exist (most common "uninstall from clean state" scenario).
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      return p === REACH_EXT_DIR || p === REACH_STATE_DIR;
    });
    mockRmSync.mockImplementation(() => undefined);
    mockReaddirSync.mockReturnValue(['config.json', 'bridge-auth.json']);
  });

  afterEach(() => {
    if (savedAppData === undefined)       delete process.env['APPDATA'];
    else                                  process.env['APPDATA'] = savedAppData;
    if (savedReachDataDir === undefined)  delete process.env['REACH_DATA_DIR'];
    else                                  process.env['REACH_DATA_DIR'] = savedReachDataDir;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // ── UN1: Default (wipe=false) — service + extension, preserve data ────────

  it('UN1 default: calls service uninstall and removes extension dir', async () => {
    await runUninstall({ wipe: false });

    expect(mockServiceUninstall).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith(
      REACH_EXT_DIR,
      expect.objectContaining({ recursive: true }),
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('UN2 default: does NOT remove state dir (data preserved)', async () => {
    await runUninstall({ wipe: false });

    const rmCalls = mockRmSync.mock.calls.map(([p]) => String(p));
    expect(rmCalls.every((p) => p !== REACH_STATE_DIR)).toBe(true);
  });

  it('UN3 default: wipe hint uses the resolved data dir path, not hardcoded ~/.reach', async () => {
    await runUninstall({ wipe: false });

    const logOutput = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]) => String(msg))
      .join('\n');
    expect(logOutput).toMatch(/Remove-Item/);
    expect(logOutput).toContain(REACH_STATE_DIR);  // actual resolved path used
    expect(logOutput).not.toContain('~/.reach');   // hardcoded placeholder NOT used
  });

  // ── UN4: wipe=true — also removes data dir ────────────────────────────────

  it('UN4 wipe=true: also removes ~/.reach state dir', async () => {
    await runUninstall({ wipe: true });

    expect(mockRmSync).toHaveBeenCalledWith(
      REACH_EXT_DIR,
      expect.objectContaining({ recursive: true }),
    );
    expect(mockRmSync).toHaveBeenCalledWith(
      REACH_STATE_DIR,
      expect.objectContaining({ recursive: true }),
    );
  });

  // ── UN5: Idempotent — extension dir absent ────────────────────────────────

  it('UN5 idempotent: extension dir absent → no rmSync call for ext dir, no error', async () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      return p === REACH_STATE_DIR;  // only state dir exists
    });

    // Should not throw even if ext dir is absent.
    await expect(runUninstall({ wipe: false })).resolves.toBeUndefined();
    const rmCalls = mockRmSync.mock.calls.map(([p]) => String(p));
    expect(rmCalls).not.toContain(REACH_EXT_DIR);
  });

  // ── UN6: Idempotent — neither dir exists ─────────────────────────────────

  it('UN6 idempotent: neither dir exists → succeeds without any rmSync calls', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(runUninstall({ wipe: true })).resolves.toBeUndefined();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── UN7: Resilient — removeExtension fails but service still runs ─────────

  it('UN7 resilient: removeExtension fails → service uninstall still called, exits 1', async () => {
    // Make rmSync throw so removeExtension returns { ok: false }.
    mockRmSync.mockImplementation(() => { throw new Error('EPERM: permission denied'); });

    // runUninstall should call process.exit(1) at the end (which our mock throws).
    await expect(runUninstall({ wipe: false })).rejects.toThrow('process.exit(1)');

    // Despite removeExtension failing, service uninstall still ran.
    expect(mockServiceUninstall).toHaveBeenCalledOnce();
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
  });

  // ── UN8: Composable — service rejects → step summary exits 1 ─────────────

  it('UN8 composable: uninstallService rejects → step summary exits 1', async () => {
    mockServiceUninstall.mockRejectedValue(new Error('node-windows: access denied'));

    await expect(runUninstall({ wipe: false })).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    // Extension step still ran before service step
    expect(mockRmSync).toHaveBeenCalledWith(REACH_EXT_DIR, expect.objectContaining({ recursive: true }));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('node-windows: access denied'));
  });

  // ── UN9: Composable — service resolves, all ok → no process.exit ─────────

  it('UN9 composable: uninstallService resolves and all steps ok → no process.exit', async () => {
    mockServiceUninstall.mockResolvedValue(undefined);

    await runUninstall({ wipe: false });

    expect(mockServiceUninstall).toHaveBeenCalledOnce();
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── UN10: wipe targets getReachDataDir() exclusively ─────────────────────

  it('UN10 wipe=true: rmSync only touches extension dir and state dir — nothing else', async () => {
    await runUninstall({ wipe: true });

    const rmTargets = mockRmSync.mock.calls.map(([p]) => String(p));
    // Every rmSync call must be one of our known paths — nothing extraneous.
    for (const target of rmTargets) {
      expect([REACH_EXT_DIR, REACH_STATE_DIR]).toContain(target);
    }
  });

  // ── UN11: env-override path used in wipe hint ─────────────────────────────

  it('UN11 env-override: wipe hint uses REACH_DATA_DIR override, not ~/.reach', async () => {
    const customDir = 'D:\\custom\\reach-data';
    process.env['REACH_DATA_DIR'] = customDir;

    await runUninstall({ wipe: false });

    const logOutput = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]) => String(msg))
      .join('\n');
    expect(logOutput).toContain(customDir);
    expect(logOutput).not.toContain('~/.reach');
  });

  // ── UN12: Fail-closed — readdirSync throws → refuse wipe, no rmSync ───────

  it('UN12 fail-closed: readdirSync EPERM → ok:false, rmSync never called', async () => {
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    mockReaddirSync.mockImplementation(() => { throw eperm; });

    await expect(runUninstall({ wipe: true })).rejects.toThrow('process.exit(1)');

    // Must have logged the refusal
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('cannot inspect directory'),
    );
    // The whole point of the fix: rmSync must NOT be called for the state dir
    const rmTargets = mockRmSync.mock.calls.map(([p]) => String(p));
    expect(rmTargets).not.toContain(REACH_STATE_DIR);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
