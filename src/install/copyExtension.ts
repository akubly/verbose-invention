#!/usr/bin/env node

/**
 * Reach — Extension installer
 *
 * Copies extension.mjs from the project root to the GitHub Copilot CLI
 * extensions directory so the Copilot CLI can load the Reach extension.
 *
 * Usage:
 *   node dist/install/copyExtension.js
 *
 * Target path (Windows):
 *   %APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs
 *
 * Re-running is safe — the copy is unconditional (idempotent overwrite).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isDirectRun } from './isDirectRun.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Returns the project root: dist/install/ → dist/ → project root */
function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function copyExtension(): void {
  // --- Validate APPDATA ---
  const appData = process.env['APPDATA'];
  if (!appData) {
    console.error('[reach] ERROR: APPDATA environment variable is not set.');
    console.error('[reach] This installer requires a Windows environment with APPDATA configured.');
    process.exit(1);
  }

  // --- Verify Copilot CLI extensions directory exists ---
  const copilotExtensionsDir = path.join(appData, 'GitHub Copilot', 'User', 'extensions');
  if (!fs.existsSync(copilotExtensionsDir)) {
    console.error('[reach] ERROR: GitHub Copilot CLI not detected. Install it first.');
    console.error(`[reach] Expected directory: ${copilotExtensionsDir}`);
    process.exit(1);
  }

  const repoRoot = getProjectRoot();
  const targetDir = path.join(copilotExtensionsDir, 'reach');
  const isDev = process.env['NODE_ENV'] === 'development';

  if (isDev) {
    // Dev mode: create a Windows directory junction so edits to extension.mjs
    // in the repo root apply immediately without re-running this script.
    // The junction points reach/ → repo root; Copilot CLI resolves
    // reach\extension.mjs through it.
    if (fs.existsSync(targetDir)) {
      // On Windows, rmSync on a junction removes the reparse point only, not the target.
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[reach] ERROR: Could not remove existing extension directory: ${message}`);
        process.exit(1);
      }
    }

    try {
      fs.symlinkSync(repoRoot, targetDir, 'junction');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] ERROR: Could not create junction: ${message}`);
      console.error('[reach] HINT: Junction creation failed. Common causes:');
      console.error('[reach]   - Parent directory not writable (check permissions on the extensions/ folder)');
      console.error('[reach]   - Target is on a network or FAT drive (junctions require NTFS)');
      console.error('[reach]   - Another process has the path locked');
      process.exit(1);
    }

    console.log(`[reach] Extension linked (dev mode): ${targetDir}`);
  } else {
    // Production mode: validate source, ensure real directory, copy file.

    // --- Validate source file exists ---
    const sourcePath = path.join(repoRoot, 'extension.mjs');
    if (!fs.existsSync(sourcePath)) {
      console.error(`[reach] ERROR: Source file not found: ${sourcePath}`);
      console.error('[reach] HINT: Ensure extension.mjs is present at the project root.');
      process.exit(1);
    }

    // Production: ensure targetDir is a real directory, not a stale junction
    // from a prior dev install.
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] ERROR: Could not create extension directory: ${message}`);
      process.exit(1);
    }

    // --- Copy extension.mjs (unconditional overwrite — idempotent) ---
    const targetPath = path.join(targetDir, 'extension.mjs');
    try {
      fs.copyFileSync(sourcePath, targetPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reach] ERROR: Could not copy extension file: ${message}`);
      process.exit(1);
    }

    console.log(`[reach] Extension installed: ${targetPath}`);
  }
}

// Only run when executed directly, not when imported
if (isDirectRun(import.meta.url)) {
  copyExtension();
}
