/**
 * migrate.ts — One-shot legacy state migration helper (Approach A).
 *
 * Added: 2026-05-31 (PR #10 Cycle 3 — Option D storage unification).
 *
 * WHY: Before PR #10 Cycle 3, Reach split state across two Windows roots:
 *   - %APPDATA%\reach\      (config.json, registry.json)
 *   - %LOCALAPPDATA%\reach\ (bridge-auth.json)
 * The new canonical root is ~/.reach/ (os.homedir()/.reach/).
 *
 * WHAT: migrateLegacyDataDir() is called explicitly at install (runInit) and
 * daemon startup (main). It runs once per process. If ~/.reach/ already exists
 * it is a no-op (existing installs are fine, legacy dirs can be cleaned up
 * manually). If either legacy dir exists and ~/.reach/ does not, it copies
 * all files to ~/.reach/, verifies, and only then removes the legacy dirs.
 *
 * WHEN TO REMOVE: When Phase 10 ships and we are confident no installs older
 * than PR #10 are still active. At that point, delete this file and remove
 * the migrateLegacyDataDir() call sites in install/index.ts and main.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getReachDataDir } from './config.js';

/** One-shot flag: prevent double-migration within the same process. */
let migrationAttempted = false;

/**
 * Copies files from a legacy directory to the new Reach data dir.
 * Returns the list of filenames successfully copied.
 */
function copyDirContents(srcDir: string, destDir: string): string[] {
  const copied: string[] = [];
  const entries = fs.readdirSync(srcDir);
  for (const entry of entries) {
    const srcFile = path.join(srcDir, entry);
    const stat = fs.statSync(srcFile);
    if (!stat.isFile()) continue; // only copy files, not subdirectories
    const destFile = path.join(destDir, entry);
    fs.copyFileSync(srcFile, destFile);
    copied.push(entry);
  }
  return copied;
}

/**
 * Verifies that every file name in `expected` exists under `dir`.
 */
function verifyFiles(dir: string, expected: string[]): boolean {
  return expected.every((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * One-shot migration from legacy Windows state dirs to ~/.reach/.
 *
 * Called explicitly from src/install/index.ts (runInit) and src/main.ts.
 * Safe to call multiple times — after the first attempt per process the
 * function returns immediately.
 *
 * Migration triggers when at least one legacy dir still exists.
 * ~/.reach/ may already exist (e.g. from a previous partial migration that
 * failed mid-way) — in that case each legacy dir is checked individually:
 * only dirs that still exist on disk are (re-)migrated.  This ensures a
 * partial first-run does not strand un-migrated dirs forever.
 *
 * bridge-auth.json is transient and regenerated on every daemon start, so
 * it need not be preserved — but we copy it anyway for completeness.
 * The legacy dirs are removed only after all files are verified copied.
 */
export function migrateLegacyDataDir(): void {
  // Pre-Phase 8.5 Reach was Windows-only — no legacy state exists on
  // other platforms, so this migration is a no-op everywhere else.
  // When Phase 10 adds cross-platform support, there will be no legacy
  // Unix paths to migrate FROM (this codebase has never persisted state
  // outside Windows).
  if (process.platform !== 'win32') {
    return;
  }

  if (migrationAttempted) return;
  migrationAttempted = true;

  const newRoot = getReachDataDir();

  const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const legacyAppData = path.join(appData, 'reach');
  const legacyLocalAppData = path.join(localAppData, 'reach');

  const legacyDirsToMigrate: string[] = [];
  if (fs.existsSync(legacyAppData)) legacyDirsToMigrate.push(legacyAppData);
  if (fs.existsSync(legacyLocalAppData)) legacyDirsToMigrate.push(legacyLocalAppData);

  if (legacyDirsToMigrate.length === 0) return;

  // Create new root
  try {
    fs.mkdirSync(newRoot, { recursive: true });
  } catch (err) {
    console.error('[reach] Migration: failed to create new state dir:', err instanceof Error ? err.message : String(err));
    return;
  }

  for (const legacyDir of legacyDirsToMigrate) {
    let copied: string[];
    try {
      copied = copyDirContents(legacyDir, newRoot);
    } catch (err) {
      console.error(
        `[reach] Migration: failed to copy files from ${legacyDir}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    if (copied.length === 0) {
      // Empty legacy dir — just remove it.
      try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
      continue;
    }

    // Verify all files were copied before removing the legacy dir.
    if (!verifyFiles(newRoot, copied)) {
      console.error(`[reach] Migration: verification failed for ${legacyDir} — legacy dir preserved.`);
      continue;
    }

    try {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[reach] Migration: could not remove legacy dir ${legacyDir} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    console.log(`[reach] Migrated state from ${legacyDir} to ${newRoot}`);
  }
}
