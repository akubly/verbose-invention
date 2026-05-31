/**
 * Tests for src/install/copyExtension.ts
 *
 * Contract under test (per .copilot/reach-install-handoff.md §Extension Install Mechanics):
 *   1. Resolves target = %APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs
 *   2. Extensions parent dir missing → exit(1) "GitHub Copilot CLI not detected"
 *   3. reach/ subdir missing → created before copy
 *   4. Copies extension.mjs from project root → target (unconditional overwrite)
 *   5. Idempotent: second run succeeds
 *   6. Logs target path on success
 *
 * Edge cases covered:
 *   - APPDATA unset → clear error, not cryptic crash
 *   - Source extension.mjs missing → clear error
 *   - Permissions error on mkdir → propagates useful message, exit(1)
 *   - Permissions error on copy → propagates useful message, exit(1)
 *   - Path with spaces / unicode in APPDATA (user profile with space in name)
 *
 * Dev-junction mode (NODE_ENV=development) — TC10–TC13:
 *   - Calls fs.symlinkSync(projectRoot, reachDir, 'junction') instead of copyFileSync
 *   - Removes existing reach/ entry before creating junction
 *   - Logs "linked (dev mode)" not "installed"
 *   - Regression: NODE_ENV=production still uses copy path
 *
 * NOTE (TC10–TC13): Junction support is behind a TODO in the current copyExtension.ts
 * implementation. These tests will be RED until Carter adds the NODE_ENV=development branch.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as path from 'path';

// ─── Mock fs ─────────────────────────────────────────────────────────────────
// Spread actual so non-overridden exports (constants, etc.) still work.

const mockExistsSync   = vi.fn<[unknown], boolean>(() => false);
const mockMkdirSync    = vi.fn<[unknown, unknown?], void>(() => undefined);
const mockCopyFileSync = vi.fn<[unknown, unknown], void>(() => undefined);
const mockSymlinkSync  = vi.fn<[unknown, unknown, unknown?], void>(() => undefined);
const mockRmSync       = vi.fn<[unknown, unknown?], void>(() => undefined);

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync:   (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync:    (...args: unknown[]) => mockMkdirSync(...args),
    copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
    symlinkSync:  (...args: unknown[]) => mockSymlinkSync(...args),
    rmSync:       (...args: unknown[]) => mockRmSync(...args),
  };
});

// ─── Import the module under test AFTER mocks are registered ─────────────────
import { copyExtension } from '../../src/install/copyExtension.js';

// ─── Stable path constants ────────────────────────────────────────────────────
// APPDATA value used in happy-path tests (contains a space — edge-case coverage).
const MOCK_APPDATA      = 'C:\\Users\\Aaron Smith\\AppData\\Roaming';
const EXTENSIONS_DIR    = path.join(MOCK_APPDATA, 'GitHub Copilot', 'User', 'extensions');
const REACH_DIR         = path.join(EXTENSIONS_DIR, 'reach');
const TARGET_PATH       = path.join(REACH_DIR, 'extension.mjs');
// Project root as seen when running under vitest (cwd = project root).
const PROJECT_ROOT      = process.cwd();
const SOURCE_PATH       = path.join(PROJECT_ROOT, 'extension.mjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Default existsSync: extensions dir exists, reach/ exists, source exists.
 * Individual tests override specific paths as needed.
 */
function defaultExistsSync(filePath: unknown): boolean {
  const p = String(filePath);
  if (p === EXTENSIONS_DIR) return true;
  if (p === REACH_DIR)       return true;
  if (p === SOURCE_PATH)     return true;
  return false;
}

// ─── Spies (initialised in beforeAll) ────────────────────────────────────────

let mockExit:         ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
let mockConsoleLog:   ReturnType<typeof vi.spyOn<typeof console, 'log'>>;
let mockConsoleError: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;

let savedAppData:  string | undefined;
let savedNodeEnv:  string | undefined;

// ─── Suite setup ─────────────────────────────────────────────────────────────

describe('copyExtension()', () => {
  beforeAll(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockConsoleLog   = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  beforeEach(() => {
    savedAppData = process.env['APPDATA'];
    savedNodeEnv = process.env['NODE_ENV'];
    process.env['APPDATA'] = MOCK_APPDATA;
    // Default: production mode (no junction).
    delete process.env['NODE_ENV'];

    vi.clearAllMocks();

    // Re-establish process.exit mock after clearAllMocks (it resets implementations).
    mockExit.mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockConsoleLog.mockImplementation(() => {});
    mockConsoleError.mockImplementation(() => {});

    // Default: all prerequisite paths exist, copy succeeds.
    mockExistsSync.mockImplementation(defaultExistsSync);
    mockMkdirSync.mockImplementation(() => undefined);
    mockCopyFileSync.mockImplementation(() => undefined);
    mockSymlinkSync.mockImplementation(() => undefined);
    mockRmSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedAppData === undefined) {
      delete process.env['APPDATA'];
    } else {
      process.env['APPDATA'] = savedAppData;
    }
    if (savedNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = savedNodeEnv;
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // ── TC1: Happy path ───────────────────────────────────────────────────────

  it('TC1 happy path: copies extension.mjs and logs the target path', () => {
    copyExtension();

    expect(mockCopyFileSync).toHaveBeenCalledOnce();
    expect(mockCopyFileSync).toHaveBeenCalledWith(SOURCE_PATH, TARGET_PATH);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining(TARGET_PATH),
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── TC2: First install — reach/ subdir does not exist ─────────────────────

  it('TC2 first install: creates reach/ subdir when it does not exist', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p === EXTENSIONS_DIR) return true;   // Copilot CLI installed
      if (p === REACH_DIR)       return false;  // reach/ not yet created
      if (p === SOURCE_PATH)     return true;
      return false;
    });

    copyExtension();

    expect(mockMkdirSync).toHaveBeenCalledWith(REACH_DIR, { recursive: true });
    expect(mockCopyFileSync).toHaveBeenCalledWith(SOURCE_PATH, TARGET_PATH);
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── TC3: Upgrade / idempotent overwrite ───────────────────────────────────

  it('TC3 upgrade: overwrites existing extension file without error (idempotent)', () => {
    // All paths exist (target file is implicitly overwritten by copyFileSync).
    copyExtension();

    // Should not error, should call copyFileSync unconditionally.
    expect(mockCopyFileSync).toHaveBeenCalledOnce();
    expect(mockExit).not.toHaveBeenCalled();
    // Log should confirm installed path.
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('[reach] Extension installed:'));
  });

  // ── TC4: Copilot CLI not installed ────────────────────────────────────────

  it('TC4 no Copilot CLI: exits 1 with "GitHub Copilot CLI not detected"', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p === EXTENSIONS_DIR) return false;  // Copilot CLI not installed
      return false;
    });

    expect(() => copyExtension()).toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('GitHub Copilot CLI not detected'),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  // ── TC5: APPDATA env var unset ────────────────────────────────────────────

  it('TC5 APPDATA unset: exits 1 with a clear message (no cryptic crash)', () => {
    delete process.env['APPDATA'];

    expect(() => copyExtension()).toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('APPDATA'),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  // ── TC6: Source extension.mjs missing ────────────────────────────────────

  it('TC6 source missing: exits 1 with message about source file', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p === EXTENSIONS_DIR) return true;
      if (p === REACH_DIR)       return true;
      if (p === SOURCE_PATH)     return false;  // extension.mjs absent
      return false;
    });

    expect(() => copyExtension()).toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Source file not found'),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  // ── TC7: Path with spaces / unicode in APPDATA ───────────────────────────
  // Regression guard: Windows user profile names routinely contain spaces
  // (e.g., "C:\Users\Aaron Smith\..."). Confirm no path-join misbehaviour.

  it('TC7 spaces in APPDATA path: handles spaces and unicode in user profile correctly', () => {
    const unicodeAppData = 'C:\\Users\\Aaröñ Śmíth\\AppData\\Roaming';
    process.env['APPDATA'] = unicodeAppData;

    const unicodeExtDir   = path.join(unicodeAppData, 'GitHub Copilot', 'User', 'extensions');
    const unicodeReachDir = path.join(unicodeExtDir, 'reach');
    const unicodeSrc      = path.join(PROJECT_ROOT, 'extension.mjs');
    const unicodeTarget   = path.join(unicodeReachDir, 'extension.mjs');

    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p === unicodeExtDir)   return true;
      if (p === unicodeReachDir) return true;
      if (p === unicodeSrc)      return true;
      return false;
    });

    copyExtension();

    expect(mockCopyFileSync).toHaveBeenCalledWith(unicodeSrc, unicodeTarget);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining(unicodeTarget),
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  // ── TC8: Permissions error on mkdir ───────────────────────────────────────

  it('TC8 mkdir EPERM: exits 1 with a useful error message', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p === EXTENSIONS_DIR) return true;
      if (p === REACH_DIR)       return false;  // triggers mkdirSync
      if (p === SOURCE_PATH)     return true;
      return false;
    });
    const permError = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    mockMkdirSync.mockImplementation(() => { throw permError; });

    expect(() => copyExtension()).toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('EPERM'),
    );
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  // ── TC9: Permissions error on copyFileSync ────────────────────────────────

  it('TC9 copyFileSync EPERM: exits 1 with a useful error message', () => {
    const permError = Object.assign(new Error('EPERM: operation not permitted, copyfile'), { code: 'EPERM' });
    mockCopyFileSync.mockImplementation(() => { throw permError; });

    expect(() => copyExtension()).toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('EPERM'),
    );
  });

  // ── Dev-junction mode (NODE_ENV=development) ──────────────────────────────
  //
  // ⚠️  TC10–TC13 are RED until Carter adds the NODE_ENV=development branch.
  //     The junction logic is behind a TODO comment in the current implementation.
  //     Contract: when NODE_ENV=development, fs.symlinkSync(projectRoot, reachDir, 'junction')
  //     is called instead of fs.copyFileSync, and any existing entry at reachDir is removed
  //     first with fs.rmSync.

  describe('junction mode (NODE_ENV=development)', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'development';
    });

    it('TC10 dev junction: calls symlinkSync(projectRoot, reachDir, "junction") — NOT copyFileSync', () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p === EXTENSIONS_DIR) return true;
        if (p === REACH_DIR)       return false;  // no existing reach/
        return false;
      });

      copyExtension();

      expect(mockSymlinkSync).toHaveBeenCalledOnce();
      expect(mockSymlinkSync).toHaveBeenCalledWith(PROJECT_ROOT, REACH_DIR, 'junction');
      expect(mockCopyFileSync).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('TC11 dev junction: logs "linked (dev mode)" not "installed"', () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p === EXTENSIONS_DIR) return true;
        if (p === REACH_DIR)       return false;
        return false;
      });

      copyExtension();

      const logMessages = (mockConsoleLog as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => String(args[0]),
      );
      // Should mention "dev" or "linked" — NOT the prod "Extension installed" message.
      expect(logMessages.some((m) => /link|dev/i.test(m))).toBe(true);
      expect(logMessages.some((m) => m.includes('Extension installed:'))).toBe(false);
    });

    it('TC12 dev junction: existing entry at reachDir is removed before creating junction', () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p === EXTENSIONS_DIR) return true;
        if (p === REACH_DIR)       return true;  // existing junction/dir present
        return false;
      });

      copyExtension();

      // rmSync must be called with reachDir BEFORE symlinkSync.
      expect(mockRmSync).toHaveBeenCalledWith(REACH_DIR, expect.objectContaining({ recursive: true }));
      expect(mockSymlinkSync).toHaveBeenCalledWith(PROJECT_ROOT, REACH_DIR, 'junction');

      // Verify ordering: rmSync index < symlinkSync index in call order.
      const rmOrder       = mockRmSync.mock.invocationCallOrder[0] ?? Infinity;
      const symlinkOrder  = mockSymlinkSync.mock.invocationCallOrder[0] ?? -Infinity;
      expect(rmOrder).toBeLessThan(symlinkOrder);
    });

    it('TC13 dev junction: when reach/ absent, rmSync is NOT called before symlinkSync', () => {
      mockExistsSync.mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p === EXTENSIONS_DIR) return true;
        if (p === REACH_DIR)       return false;  // nothing to remove
        return false;
      });

      copyExtension();

      expect(mockRmSync).not.toHaveBeenCalled();
      expect(mockSymlinkSync).toHaveBeenCalledWith(PROJECT_ROOT, REACH_DIR, 'junction');
    });
  });

  // ── Regression: non-development NODE_ENV still uses copy ──────────────────

  it('TC14 NODE_ENV=production: uses copyFileSync, never symlinkSync', () => {
    process.env['NODE_ENV'] = 'production';

    copyExtension();

    expect(mockCopyFileSync).toHaveBeenCalledOnce();
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });
});
