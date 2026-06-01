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
import { uninstall } from '../service/install.js';
import { isDirectRun } from './isDirectRun.js';

export interface UninstallOptions {
  /** When true, also deletes %LOCALAPPDATA%\reach\ (config + session data). */
  wipe: boolean;
}

interface StepResult {
  label: string;
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Uninstall steps
// ---------------------------------------------------------------------------

function removeExtension(): StepResult {
  const appData = process.env['APPDATA'];
  if (!appData) {
    console.log('[reach] APPDATA not set — skipping extension removal.');
    return { label: 'Remove extension', ok: true };
  }
  const extensionDir = path.join(appData, 'GitHub Copilot', 'User', 'extensions', 'reach');
  if (fs.existsSync(extensionDir)) {
    try {
      fs.rmSync(extensionDir, { recursive: true, force: true });
      console.log(`[reach] Extension removed: ${extensionDir}`);
      return { label: 'Remove extension', ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] ERROR: Could not remove extension directory: ${message}`);
      return { label: 'Remove extension', ok: false, reason: message };
    }
  } else {
    console.log('[reach] Extension directory not found — nothing to remove.');
    return { label: 'Remove extension', ok: true };
  }
}

function wipeLocalData(): StepResult {
  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData) {
    console.log('[reach] LOCALAPPDATA not set — skipping local state wipe.');
    return { label: 'Wipe local data', ok: true };
  }
  const localDir = path.join(localAppData, 'reach');
  if (fs.existsSync(localDir)) {
    const markerFiles = ['config.json', 'bridge-auth.json'];
    try {
      const entries = new Set(fs.readdirSync(localDir));
      const hasMarker = markerFiles.some((marker) => entries.has(marker));
      if (!hasMarker) {
        const reason = `Refusing to wipe ${localDir}: doesn't look like a Reach state directory.`;
        console.error(`[reach] ${reason}`);
        return { label: 'Wipe local data', ok: false, reason };
      }
    } catch {
      // If we cannot inspect the directory entries, continue with best-effort wipe.
    }
    try {
      fs.rmSync(localDir, { recursive: true, force: true });
      console.log(`[reach] Local state wiped: ${localDir}`);
      return { label: 'Wipe local data', ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] WARNING: Could not remove local state: ${message}`);
      return { label: 'Wipe local data', ok: false, reason: message };
    }
  } else {
    console.log('[reach] Local state directory not found — nothing to wipe.');
    return { label: 'Wipe local data', ok: true };
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

  const results: StepResult[] = [];

  // Remove extension directory (handles plain dir or dev-mode junction)
  results.push(removeExtension());

  if (opts.wipe) {
    results.push(wipeLocalData());
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

  // If the service uninstaller returned (e.g., in tests or on some platforms),
  // report the step summary and exit non-zero if any earlier step failed.
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    const succeeded = results.length - failed.length;
    console.error(`[reach] ${failed.length} step(s) failed, ${succeeded} succeeded.`);
    for (const r of failed) {
      console.error(`[reach]   ✗ ${r.label}: ${r.reason ?? 'unknown error'}`);
    }
    process.exit(1);
  }
}

// Only run when executed directly, not when imported
if (isDirectRun(import.meta.url)) {
  const wipe = process.argv.includes('--wipe');
  runUninstall({ wipe });
}
