#!/usr/bin/env node

/**
 * Reach — Uninstaller
 *
 * Usage:
 *   node dist/install/uninstall.js           # uninstall service + remove extension
 *   node dist/install/uninstall.js --wipe    # also delete ~/.reach/
 *   npm run uninstall
 *   npm run uninstall -- --wipe
 *
 * Safe to run twice (idempotent). Each step is attempted regardless of whether
 * a previous step found anything to remove.
 */

import * as fs from 'fs';
import * as path from 'path';
import { uninstallService } from '../service/install.js';
import { isDirectRun } from './isDirectRun.js';
import { getReachDataDir } from '../config/config.js';

export interface UninstallOptions {
  /** When true, also deletes ~/.reach/ (config + session data). */
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
  const reachDir = getReachDataDir();
  if (fs.existsSync(reachDir)) {
    const markerFiles = ['config.json', 'bridge-auth.json'];
    try {
      const entries = new Set(fs.readdirSync(reachDir));
      const hasMarker = markerFiles.some((marker) => entries.has(marker));
      if (!hasMarker) {
        const reason = `Refusing to wipe ${reachDir}: doesn't look like a Reach state directory.`;
        console.error(`[reach] ${reason}`);
        return { label: 'Wipe local data', ok: false, reason };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = `Refusing to wipe ${reachDir}: cannot inspect directory (${message}). Verify the path exists and you have read permissions.`;
      console.error(`[reach] ${reason}`);
      return { label: 'Wipe local data', ok: false, reason };
    }
    try {
      fs.rmSync(reachDir, { recursive: true, force: true });
      console.log(`[reach] Local state wiped: ${reachDir}`);
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

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  console.log('[reach] ════════════════════════════════════════════════════');
  console.log('[reach]  Reach — Uninstall');
  console.log('[reach] ════════════════════════════════════════════════════');
  console.log('[reach]');

  // Sync filesystem cleanup runs first; uninstallService() returns a Promise
  // and does NOT call process.exit(). The orchestrator accumulates step results
  // and exits at the end with the appropriate code.

  const results: StepResult[] = [];

  // Remove extension directory (handles plain dir or dev-mode junction)
  results.push(removeExtension());

  if (opts.wipe) {
    results.push(wipeLocalData());
  } else {
    const reachDir = getReachDataDir();
    console.log(`[reach] Local state preserved: ${reachDir}`);
    console.log('[reach] To wipe it manually:');
    console.log(`[reach]   Remove-Item -Recurse -Force "${reachDir}"`);
    console.log('[reach] Or re-run:  npm run uninstall -- --wipe');
  }

  console.log('[reach]');

  // Service uninstall — composable; errors are accumulated into step results
  console.log('[reach] Uninstalling Windows service…');
  try {
    await uninstallService();
    results.push({ label: 'Uninstall Windows service', ok: true });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[reach] ERROR: Service uninstall failed: ${reason}`);
    results.push({ label: 'Uninstall Windows service', ok: false, reason });
  }

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
  runUninstall({ wipe })
    .then(() => { process.exit(0); })
    .catch(() => { process.exit(1); });
}
