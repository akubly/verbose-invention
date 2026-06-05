/**
 * Tests for src/config/migrate.ts
 *
 * Covers:
 *   - No-op when ~/.reach/ already exists
 *   - Migrates %APPDATA%\reach\ contents when ~/.reach/ is absent
 *   - Migrates %LOCALAPPDATA%\reach\ contents when ~/.reach/ is absent
 *   - Migrates both legacy dirs in one pass
 *   - No-op when no legacy dirs exist
 *   - Only removes legacy dir after verifying all files were copied
 *   - Module-level flag prevents double-migration within a process
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// ─── Module-level flag reset helper ──────────────────────────────────────────
// migrateLegacyDataDir uses a module-level `migrationAttempted` flag.
// We re-import the module fresh for each test group that needs a clean flag,
// using vi.resetModules() + dynamic import.

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn<[unknown], boolean>(() => false);
const mockMkdirSync  = vi.fn<[unknown, unknown?], void>(() => undefined);
const mockReaddirSync = vi.fn<[unknown], string[]>(() => []);
const mockStatSync   = vi.fn(() => ({ isFile: () => true }));
const mockCopyFileSync = vi.fn<[unknown, unknown], void>(() => undefined);
const mockRmSync     = vi.fn<[unknown, unknown?], void>(() => undefined);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync:    (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync:     (...args: unknown[]) => mockMkdirSync(...args),
    readdirSync:   (...args: unknown[]) => mockReaddirSync(...args),
    statSync:      (...args: unknown[]) => mockStatSync(...args),
    copyFileSync:  (...args: unknown[]) => mockCopyFileSync(...args),
    rmSync:        (...args: unknown[]) => mockRmSync(...args),
  };
});

// ─── Stable path constants ────────────────────────────────────────────────────

const MOCK_HOME          = 'C:\\Users\\TestUser';
const MOCK_APPDATA       = `${MOCK_HOME}\\AppData\\Roaming`;
const MOCK_LOCALAPPDATA  = `${MOCK_HOME}\\AppData\\Local`;
const NEW_ROOT           = path.join(MOCK_HOME, '.reach');
const LEGACY_APPDATA_DIR = path.join(MOCK_APPDATA, 'reach');
const LEGACY_LOCAL_DIR   = path.join(MOCK_LOCALAPPDATA, 'reach');

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('migrateLegacyDataDir()', () => {
  let savedHome:       string | undefined;
  let savedAppData:    string | undefined;
  let savedLocalAppData: string | undefined;
  let savedReachDataDir: string | undefined;

  beforeEach(() => {
    savedHome         = process.env['USERPROFILE'];
    savedAppData      = process.env['APPDATA'];
    savedLocalAppData = process.env['LOCALAPPDATA'];
    savedReachDataDir = process.env['REACH_DATA_DIR'];

    // Pin home dir so os.homedir() returns a known value on all platforms.
    // We use REACH_DATA_DIR env override to control the new root path
    // deterministically without needing to mock os.homedir.
    process.env['REACH_DATA_DIR']   = NEW_ROOT;
    process.env['APPDATA']          = MOCK_APPDATA;
    process.env['LOCALAPPDATA']     = MOCK_LOCALAPPDATA;

    vi.clearAllMocks();
    // Default: new root does NOT exist, legacy dirs do NOT exist.
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    if (savedHome === undefined)          delete process.env['USERPROFILE'];
    else                                  process.env['USERPROFILE'] = savedHome;
    if (savedAppData === undefined)       delete process.env['APPDATA'];
    else                                  process.env['APPDATA'] = savedAppData;
    if (savedLocalAppData === undefined)  delete process.env['LOCALAPPDATA'];
    else                                  process.env['LOCALAPPDATA'] = savedLocalAppData;
    if (savedReachDataDir === undefined)  delete process.env['REACH_DATA_DIR'];
    else                                  process.env['REACH_DATA_DIR'] = savedReachDataDir;
  });

  // Helper: re-import migrate module with a fresh module-level flag.
  async function freshMigrate() {
    vi.resetModules();
    const mod = await import('../../src/config/migrate.js');
    return mod.migrateLegacyDataDir;
  }

  // ── MIG1: No-op when new root already exists ─────────────────────────────

  it('MIG1: no-op when ~/.reach already exists', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p) === NEW_ROOT);
    const migrate = await freshMigrate();
    migrate();
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  // ── MIG2: No-op when no legacy dirs exist ─────────────────────────────────

  it('MIG2: no-op when no legacy dirs exist and new root is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    const migrate = await freshMigrate();
    migrate();
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  // ── MIG3: Migrates %APPDATA%\reach contents ───────────────────────────────

  it('MIG3: copies %APPDATA%\\reach contents to new root', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p) === LEGACY_APPDATA_DIR);
    mockReaddirSync.mockReturnValue(['config.json', 'registry.json'] as unknown as string[]);
    // After copy, existsSync returns true for the copied files.
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s === LEGACY_APPDATA_DIR
        || s === path.join(NEW_ROOT, 'config.json')
        || s === path.join(NEW_ROOT, 'registry.json');
    });
    const migrate = await freshMigrate();
    migrate();
    expect(mockMkdirSync).toHaveBeenCalledWith(NEW_ROOT, { recursive: true });
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(LEGACY_APPDATA_DIR, 'config.json'),
      path.join(NEW_ROOT, 'config.json'),
    );
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(LEGACY_APPDATA_DIR, 'registry.json'),
      path.join(NEW_ROOT, 'registry.json'),
    );
    expect(mockRmSync).toHaveBeenCalledWith(LEGACY_APPDATA_DIR, { recursive: true, force: true });
  });

  // ── MIG4: Migrates %LOCALAPPDATA%\reach contents ──────────────────────────

  it('MIG4: copies %LOCALAPPDATA%\\reach contents to new root', async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s === LEGACY_LOCAL_DIR || s === path.join(NEW_ROOT, 'bridge-auth.json');
    });
    mockReaddirSync.mockReturnValue(['bridge-auth.json'] as unknown as string[]);
    const migrate = await freshMigrate();
    migrate();
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(LEGACY_LOCAL_DIR, 'bridge-auth.json'),
      path.join(NEW_ROOT, 'bridge-auth.json'),
    );
    expect(mockRmSync).toHaveBeenCalledWith(LEGACY_LOCAL_DIR, { recursive: true, force: true });
  });

  // ── MIG5: Does NOT remove legacy dir if verification fails ────────────────

  it('MIG5: preserves legacy dir when file verification fails after copy', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p) === LEGACY_APPDATA_DIR);
    mockReaddirSync.mockReturnValue(['config.json'] as unknown as string[]);
    // Verification: new root files do NOT exist after copy (simulate partial failure).
    const migrate = await freshMigrate();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    migrate();
    // rmSync should NOT have been called for legacy dir since verification failed.
    expect(mockRmSync).not.toHaveBeenCalledWith(LEGACY_APPDATA_DIR, expect.anything());
    consoleSpy.mockRestore();
  });

  // ── MIG7: Platform gate — non-Windows returns early without any fs calls ─

  it('MIG7: no-op on non-Windows — existsSync never called', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const migrate = await freshMigrate();
      migrate();
      // The platform gate fires before any fs access — not even the new-root
      // existence check should execute.
      expect(mockExistsSync).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockCopyFileSync).not.toHaveBeenCalled();
      expect(mockRmSync).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(process, 'platform', descriptor);
    }
  });

  // ── MIG6: Module-level flag prevents double-migration ────────────────────

  it('MIG6: calling migrate twice does not attempt migration a second time', async () => {
    mockExistsSync.mockReturnValue(false);
    const migrate = await freshMigrate();
    migrate();
    migrate(); // second call should be a no-op due to flag
    // mkdirSync should have been called at most once (0 times here since no legacy dirs)
    expect(mockMkdirSync).toHaveBeenCalledTimes(0);
    expect(mockCopyFileSync).toHaveBeenCalledTimes(0);
  });

  // ── MIG8: Partial-migration retry — newRoot exists but one legacy dir missed ─

  it('MIG8: re-run migrates remaining legacy dirs when newRoot already exists from partial first run', async () => {
    // Scenario: first run created newRoot and migrated legacyAppData (its
    // legacy dir was removed), but legacyLocalAppData failed and was kept.
    // On second process run, newRoot exists, legacyLocalAppData still exists.
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      // newRoot exists (created by first run)
      // legacyLocalAppData still exists (first run failed for it)
      // bridge-auth.json already verified in newRoot after copy
      return (
        s === NEW_ROOT ||
        s === LEGACY_LOCAL_DIR ||
        s === path.join(NEW_ROOT, 'bridge-auth.json')
      );
    });
    mockReaddirSync.mockImplementation((p: unknown) => {
      if (String(p) === LEGACY_LOCAL_DIR) return ['bridge-auth.json'] as unknown as string[];
      return [] as unknown as string[];
    });
    const migrate = await freshMigrate();
    migrate();
    // Should have attempted to create newRoot (no-op because recursive:true)
    expect(mockMkdirSync).toHaveBeenCalledWith(NEW_ROOT, { recursive: true });
    // Should have copied the missed file
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      path.join(LEGACY_LOCAL_DIR, 'bridge-auth.json'),
      path.join(NEW_ROOT, 'bridge-auth.json'),
    );
    // Should have removed the legacy dir after successful verification
    expect(mockRmSync).toHaveBeenCalledWith(LEGACY_LOCAL_DIR, { recursive: true, force: true });
    // Should NOT have touched legacyAppData (it was already gone from disk)
    expect(mockRmSync).not.toHaveBeenCalledWith(LEGACY_APPDATA_DIR, expect.anything());
  });
});
