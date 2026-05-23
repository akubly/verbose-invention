/**
 * pipeAuth.ts — Per-run pipe authentication (ADR-10).
 *
 * Generates a randomized pipe name and single-use token at daemon startup,
 * written atomically to %LOCALAPPDATA%\reach\bridge-auth.json. The CLI
 * extension reads this file to discover the pipe name and include the token
 * in every `hello` message.
 *
 * Defense layers (ADR-10):
 *   Option A (primary): random pipe name + per-run token in user-scoped file.
 *   Option B (belt-and-suspenders): owner-only ACL on the auth file. Full
 *   SID verification via GetNamedPipeClientProcessId requires a native addon
 *   (e.g. koffi) and is deferred to a future phase.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface PipeAuthConfig {
  /** e.g. "reach-bridge-a1b2c3d4e5f6a7b8" */
  pipeName: string;
  /** Full Windows named-pipe path: "\\.\pipe\{pipeName}" */
  pipePath: string;
  /** 32-byte CSPRNG token, hex-encoded (64 chars). */
  token: string;
}

interface PipeAuthFile {
  pipeName: string;
  token: string;
  createdAt: string;
}

/** Returns the platform-aware path to the auth file. */
export function getAuthFilePath(): string {
  const localAppData =
    process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'reach', 'bridge-auth.json');
}

/**
 * Generate fresh pipe auth credentials, write them atomically to the auth
 * file, and apply an owner-only ACL on Windows.
 *
 * Must be called once at daemon startup before `ExtensionBridge.start()`.
 * Regenerating on every startup invalidates any stale bridge-auth.json left
 * by a previous daemon run.
 */
export async function generatePipeAuth(): Promise<PipeAuthConfig> {
  const nameSuffix = crypto.randomBytes(8).toString('hex'); // 16 hex chars
  const pipeName = `reach-bridge-${nameSuffix}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const token = crypto.randomBytes(32).toString('hex'); // 64 hex chars

  const authFile: PipeAuthFile = {
    pipeName,
    token,
    createdAt: new Date().toISOString(),
  };

  const filePath = getAuthFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Atomic write: write to .tmp then rename so readers never see a partial file.
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(authFile, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);

  // Option B (partial): restrict to owner-only ACL on Windows.
  // %LOCALAPPDATA% itself is user-scoped, so this is belt-and-suspenders.
  // Non-fatal if icacls fails (e.g. running in a container without icacls).
  if (os.platform() === 'win32') {
    try {
      const username = os.userInfo().username;
      execFileSync(
        'icacls',
        [filePath, '/inheritance:r', '/grant:r', `${username}:(R,W)`],
        { stdio: 'pipe' },
      );
    } catch (err) {
      console.warn(
        '[bridge] Could not set restrictive ACL on auth file (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { pipeName, pipePath, token };
}

/**
 * Remove the auth file when the daemon shuts down.
 * Swallows ENOENT (already deleted) — any other error is logged and swallowed
 * since the daemon is shutting down and cannot recover.
 */
export async function cleanupPipeAuth(): Promise<void> {
  const filePath = getAuthFilePath();
  try {
    await fs.unlink(filePath);
    console.log(`[bridge] Auth file removed: ${filePath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        '[bridge] Could not remove auth file on shutdown (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
export async function readPipeAuth(): Promise<PipeAuthConfig | null> {
  const filePath = getAuthFilePath();
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as PipeAuthFile;
    if (typeof data.pipeName !== 'string' || typeof data.token !== 'string') {
      return null;
    }
    return {
      pipeName: data.pipeName,
      pipePath: `\\\\.\\pipe\\${data.pipeName}`,
      token: data.token,
    };
  } catch {
    return null;
  }
}
