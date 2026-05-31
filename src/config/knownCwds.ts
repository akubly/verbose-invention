/**
 * Helpers for the knownCwds registry stored inside config.json.
 *
 * All mutating helpers (add/remove/touch) return a NEW ReachConfig — callers
 * must persist the returned value via saveConfig().
 *
 * Validation is split by sync/async:
 *   - validateAlias()  — sync  (string-only rules)
 *   - validatePath()   — async (requires fs.stat to verify existence + type;
 *                               also returns an optional warning when the path
 *                               is under a sensitive system directory)
 *
 * Typical /cwd add flow:
 *   1. validateAlias(alias)             → sync guard
 *   2. validatePath(rawPath)            → async guard, returns normalized path
 *                                          + optional warning to surface to user
 *   3. addKnownCwd(config, alias, normalized, now) → immutable transform
 *   4. saveConfig(configPath, newConfig)           → persist
 */

import * as nodePath from 'path';
import * as fs from 'fs/promises';
import type { ReachConfig, KnownCwd } from './config.js';

// ─── Alias validation ────────────────────────────────────────────────────────

/**
 * 1–32 chars, starts with alphanumeric, body is [a-zA-Z0-9_-].
 * Aliases starting with `-` (e.g. `--cwd`, `--model`, `--name`) already fail
 * this regex, which prevents collision with /new flag names.
 */
const ALIAS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export function validateAlias(alias: string): { ok: true } | { ok: false; reason: string } {
  if (!ALIAS_REGEX.test(alias)) {
    return {
      ok: false,
      reason:
        'Alias must be 1–32 characters, start with a letter or digit, ' +
        'and contain only letters, digits, underscores, or hyphens',
    };
  }
  return { ok: true };
}

// ─── Path validation ─────────────────────────────────────────────────────────

/**
 * Checks whether `pathToCheck` falls under a Windows sensitive prefix.
 * Returns the matched prefix string, or `undefined` if not sensitive.
 *
 * Sensitive prefixes (Windows-only):
 *   - %WINDIR% (C:\Windows by default)
 *   - %PROGRAMDATA% (C:\ProgramData by default) — system-wide application state,
 *     service configs, and scheduled task definitions
 *   - C:\Program Files
 *   - C:\Program Files (x86)
 *   - Any user-profile directory under C:\Users\ that is NOT the current
 *     user's own profile (identified via process.env.USERPROFILE).
 *
 * All comparisons are case-insensitive (NTFS is case-preserving, not
 * case-sensitive — same convention as getKnownCwdByPath).
 */
function sensitivePrefixOf(pathToCheck: string): string | undefined {
  const lowerPath = pathToCheck.toLowerCase();

  const windir = nodePath.resolve(process.env.WINDIR ?? 'C:\\Windows');
  const programData = nodePath.resolve(process.env.PROGRAMDATA ?? 'C:\\ProgramData');
  const fixedPrefixes = [windir, programData, 'C:\\Program Files', 'C:\\Program Files (x86)'];

  for (const prefix of fixedPrefixes) {
    const prefixLower = prefix.toLowerCase();
    if (lowerPath === prefixLower || lowerPath.startsWith(prefixLower + '\\')) {
      return prefix;
    }
  }

  // Other user profile directories under C:\Users\
  const usersDirLower = 'c:\\users\\';
  if (lowerPath.startsWith(usersDirLower)) {
    const afterUsers = pathToCheck.slice(usersDirLower.length); // "Bob" or "Bob\Documents"
    const nextSep = afterUsers.indexOf('\\');
    const userName = nextSep !== -1 ? afterUsers.slice(0, nextSep) : afterUsers;
    if (userName.length > 0) {
      const profileDir = `C:\\Users\\${userName}`;
      const selfProfile =
        process.env.USERPROFILE !== undefined
          ? nodePath.resolve(process.env.USERPROFILE).toLowerCase()
          : undefined;
      const profileDirLower = profileDir.toLowerCase();
      // Flag only if this profile is NOT the current user's own profile.
      if (
        selfProfile === undefined ||
        (lowerPath !== selfProfile && !lowerPath.startsWith(selfProfile + '\\'))
      ) {
        // Exclude the bare C:\Users\ root itself (userName empty guard above handles this).
        return profileDirLower !== selfProfile ? profileDir : undefined;
      }
    }
  }

  return undefined;
}

export async function validatePath(
  inputPath: string,
): Promise<{ ok: true; normalized: string; warning?: string } | { ok: false; reason: string }> {
  if (inputPath.includes('\x00')) {
    return { ok: false, reason: 'Path contains a null byte' };
  }

  if (!nodePath.isAbsolute(inputPath)) {
    return { ok: false, reason: 'Path must be absolute' };
  }

  // Reject UNC network paths (\\server\share) — CLI does not support them.
  if (process.platform === 'win32' && inputPath.startsWith('\\\\')) {
    return { ok: false, reason: 'UNC network paths are not supported' };
  }

  const normalized = nodePath.resolve(inputPath);

  // Detect symlinks/junctions so we can flag junction-traversal warnings.
  let isSymlink = false;
  let realPath = normalized;
  try {
    const lstatResult = await fs.lstat(normalized);
    isSymlink = lstatResult.isSymbolicLink();
  } catch {
    // lstat failure is non-critical; proceed without junction detection.
  }
  if (isSymlink) {
    try {
      realPath = await fs.realpath(normalized);
    } catch {
      // realpath failure — keep realPath === normalized.
    }
  }

  try {
    const stat = await fs.stat(normalized);
    if (!stat.isDirectory()) {
      return { ok: false, reason: 'Path exists but is not a directory' };
    }
  } catch {
    return { ok: false, reason: 'Path does not exist or is not accessible' };
  }

  // Sensitive-prefix check (Windows only; warn, never block — Aaron's decision).
  if (process.platform === 'win32') {
    const directPrefix = sensitivePrefixOf(normalized);
    if (directPrefix !== undefined) {
      return {
        ok: true,
        normalized,
        warning: `Warning: path is under a sensitive directory (${directPrefix}). Sessions started here may modify system files.`,
      };
    }
    if (isSymlink) {
      const resolvedPrefix = sensitivePrefixOf(realPath);
      if (resolvedPrefix !== undefined) {
        return {
          ok: true,
          normalized,
          warning: `Warning: path is under a sensitive directory (${resolvedPrefix}). Sessions started here may modify system files. (resolved through junction)`,
        };
      }
    }
  }

  return { ok: true, normalized };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Returns all known cwds sorted by lastUsedAt descending, then alias ascending.
 * Entries without lastUsedAt sort after those that have it.
 */
export function listKnownCwds(config: ReachConfig): readonly KnownCwd[] {
  return [...(config.knownCwds ?? [])].sort((a, b) => {
    const aUsed = a.lastUsedAt;
    const bUsed = b.lastUsedAt;
    if (aUsed !== undefined && bUsed === undefined) return -1;
    if (aUsed === undefined && bUsed !== undefined) return 1;
    if (aUsed !== undefined && bUsed !== undefined) {
      const cmp = bUsed.localeCompare(aUsed); // desc
      if (cmp !== 0) return cmp;
    }
    return a.alias.localeCompare(b.alias); // asc
  });
}

/** Exact case-sensitive alias lookup. */
export function getKnownCwdByAlias(config: ReachConfig, alias: string): KnownCwd | undefined {
  return (config.knownCwds ?? []).find(c => c.alias === alias);
}

/**
 * Normalized-path lookup.
 * On Windows the comparison is case-insensitive (NTFS is case-preserving, not
 * case-sensitive). On other platforms it is case-sensitive.
 */
export function getKnownCwdByPath(config: ReachConfig, inputPath: string): KnownCwd | undefined {
  const normalized = nodePath.resolve(inputPath);
  const isWindows = process.platform === 'win32';
  return (config.knownCwds ?? []).find(c =>
    isWindows
      ? c.path.toLowerCase() === normalized.toLowerCase()
      : c.path === normalized,
  );
}

// ─── Mutation helpers (immutable — return new config) ─────────────────────────

/**
 * Returns a new config with the entry appended.
 * Throws if alias already exists or if alias/path format is invalid.
 *
 * Callers should run validateAlias + validatePath first and pass the
 * normalized path returned by validatePath. addKnownCwd re-normalizes
 * for safety but does NOT perform fs existence checks.
 */
export function addKnownCwd(
  config: ReachConfig,
  alias: string,
  path: string,
  now: string,
): ReachConfig {
  const aliasCheck = validateAlias(alias);
  if (!aliasCheck.ok) throw new Error(`Invalid alias: ${aliasCheck.reason}`);

  const existing = config.knownCwds ?? [];
  if (existing.length >= 100) {
    throw new Error('Maximum 100 known cwds reached');
  }
  if (existing.some(c => c.alias === alias)) {
    throw new Error(`Alias "${alias}" already exists in knownCwds`);
  }

  const normalized = nodePath.resolve(path);
  const entry: KnownCwd = { alias, path: normalized, addedAt: now };
  return { ...config, knownCwds: [...existing, entry] };
}

/**
 * Returns a new config with the alias removed.
 * No-op (returns the same config reference) if alias is not found.
 */
export function removeKnownCwd(config: ReachConfig, alias: string): ReachConfig {
  const existing = config.knownCwds ?? [];
  const filtered = existing.filter(c => c.alias !== alias);
  if (filtered.length === existing.length) return config; // not found — no-op
  return { ...config, knownCwds: filtered };
}

/**
 * Updates lastUsedAt for the given alias.
 * Called when a session starts in this cwd (T6/session-start hook).
 * No-op if alias is not found.
 */
export function touchKnownCwd(config: ReachConfig, alias: string, now: string): ReachConfig {
  const existing = config.knownCwds ?? [];
  let changed = false;
  const updated = existing.map(c => {
    if (c.alias !== alias) return c;
    changed = true;
    return { ...c, lastUsedAt: now };
  });
  return changed ? { ...config, knownCwds: updated } : config;
}
