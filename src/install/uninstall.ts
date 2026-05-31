#!/usr/bin/env node

/**
 * Reach — Uninstaller
 *
 * Usage:
 *   node dist/install/uninstall.js           # uninstall service + remove extension
 *   node dist/install/uninstall.js --wipe    # also delete %LOCALAPPDATA%\reach\
 *   npm run uninstall
 *   npm run uninstall -- --wipe
 *
 * Safe to run twice (idempotent). Each step is attempted regardless of whether
 * a previous step found anything to remove.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { uninstall } from '../service/install.js';

export interface UninstallOptions {
  /** When true, also deletes %LOCALAPPDATA%\reach\ (config + session data). */
  wipe: boolean;
}

// ---------------------------------------------------------------------------
// Uninstall steps
// ---------------------------------------------------------------------------

function removeExtension(): void {
  const appData = process.env['APPDATA'];
  if (!appData) {
    console.log('[reach] APPDATA not set — skipping extension removal.');
    return;
  }
  const extensionDir = path.join(appData, 'GitHub Copilot', 'User', 'extensions', 'reach');
  if (fs.existsSync(extensionDir)) {
    try {
      fs.rmSync(extensionDir, { recursive: true, force: true });
      console.log(`[reach] Extension removed: ${extensionDir}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] ERROR: Could not remove extension directory: ${message}`);
      process.exit(1);
    }
  } else {
    console.log('[reach] Extension directory not found — nothing to remove.');
  }
}

function wipeLocalData(): void {
  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData) {
    console.log('[reach] LOCALAPPDATA not set — skipping local state wipe.');
    return;
  }
  const localDir = path.join(localAppData, 'reach');
  if (fs.existsSync(localDir)) {
    const markerFiles = ['config.json', 'bridge-auth.json'];
    try {
      const entries = new Set(fs.readdirSync(localDir));
      const hasMarker = markerFiles.some((marker) => entries.has(marker));
      if (!hasMarker) {
        console.error(
          `[reach] Refusing to wipe ${localDir}: doesn't look like a Reach state directory.`,
        );
        return;
      }
    } catch {
      // If we cannot inspect the directory entries, continue with best-effort wipe.
    }
    try {
      fs.rmSync(localDir, { recursive: true, force: true });
      console.log(`[reach] Local state wiped: ${localDir}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal — log a warning and continue to service uninstall
      console.error(`[reach] WARNING: Could not remove local state: ${message}`);
    }
  } else {
    console.log('[reach] Local state directory not found — nothing to wipe.');
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runUninstall(opts: UninstallOptions): void {
  console.log('[reach] ════════════════════════════════════════════════════');
  console.log('[reach]  Reach — Uninstall');
  console.log('[reach] ════════════════════════════════════════════════════');
  console.log('[reach]');

  // Do all sync filesystem cleanup before handing off to the async service
  // uninstaller (which calls process.exit internally via node-windows events).

  // Remove extension directory (handles plain dir or dev-mode junction)
  removeExtension();

  if (opts.wipe) {
    wipeLocalData();
  } else {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData) {
      const localDir = path.join(localAppData, 'reach');
      console.log(`[reach] Local state preserved: ${localDir}`);
      console.log('[reach] To wipe it manually:');
      console.log('[reach]   Remove-Item -Recurse -Force $env:LOCALAPPDATA\\reach');
      console.log('[reach] Or re-run:  npm run uninstall -- --wipe');
    }
  }

  console.log('[reach]');

  // Service uninstall — handles its own exit via node-windows events
  console.log('[reach] Uninstalling Windows service…');
  uninstall();
}

// Only run when executed directly, not when imported
const isDirectRun =
  process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const wipe = process.argv.includes('--wipe');
  runUninstall({ wipe });
}
