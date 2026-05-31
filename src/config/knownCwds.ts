/**
 * Helpers for the knownCwds registry stored inside config.json.
 *
 * All mutating helpers (add/remove/touch) return a NEW ReachConfig — callers
 * must persist the returned value via saveConfig().
 *
 * Validation is split by sync/async:
 *   - validateAlias()  — sync  (string-only rules)
 *   - validatePath()   — async (requires fs.stat to verify existence + type)
 *
 * Typical /cwd add flow:
 *   1. validateAlias(alias)             → sync guard
 *   2. validatePath(rawPath)            → async guard, returns normalized path
 *   3. addKnownCwd(config, alias, normalized, now) → immutable transform
 *   4. saveConfig(configPath, newConfig)           → persist
 */

import * as nodePath from 'path';
import * as fs from 'fs/promises';
import type { ReachConfig, KnownCwd } from './config.js';

// ─── Alias validation ────────────────────────────────────────────────────────

/** 1–32 chars, starts with alphanumeric, body is [a-zA-Z0-9_-]. */
const ALIAS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

/**
 * Words reserved to prevent collision with /new flags.
 * These all start with `-` and therefore already fail ALIAS_REGEX,
 * but the set is kept explicit so Carter's T6/T7 parser has a clear boundary.
 */
const RESERVED_ALIASES = new Set(['--cwd', '--model', '--name']);

export function validateAlias(alias: string): { ok: true } | { ok: false; reason: string } {
  if (!ALIAS_REGEX.test(alias)) {
    return {
      ok: false,
      reason:
        'Alias must be 1–32 characters, start with a letter or digit, ' +
        'and contain only letters, digits, underscores, or hyphens',
    };
  }
  if (RESERVED_ALIASES.has(alias)) {
    return { ok: false, reason: `"${alias}" is a reserved word and cannot be used as an alias` };
  }
  return { ok: true };
}

// ─── Path validation ─────────────────────────────────────────────────────────

export async function validatePath(
  inputPath: string,
): Promise<{ ok: true; normalized: string } | { ok: false; reason: string }> {
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

  try {
    const stat = await fs.stat(normalized);
    if (!stat.isDirectory()) {
      return { ok: false, reason: 'Path exists but is not a directory' };
    }
  } catch {
    return { ok: false, reason: 'Path does not exist or is not accessible' };
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
