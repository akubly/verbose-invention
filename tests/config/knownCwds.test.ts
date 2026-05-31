/**
 * Pure unit tests for knownCwds helpers (Phase 9 Item 3, Task T5).
 *
 * Kat's implementation is live in src/config/knownCwds.ts.
 * These tests should be GREEN immediately.
 *
 * validatePath is async (uses fs.stat); all other helpers are sync.
 * fs/promises.stat is mocked so tests don't hit the real filesystem.
 * Normalization behaviour (path.resolve) is exercised with the real
 * nodePath module — no OS path tricks, just test against nodePath.resolve().
 *
 * Platform notes:
 *   - Tests that depend on Windows-only behaviour (UNC rejection, case-insensitive
 *     path lookup) are guarded with it.skipIf(process.platform !== 'win32').
 *   - A mocked-platform variant covers the case-sensitive (non-Windows) path
 *     in getKnownCwdByPath on any host OS.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as nodePath from 'path';
import {
  validateAlias,
  validatePath,
  listKnownCwds,
  getKnownCwdByAlias,
  getKnownCwdByPath,
  addKnownCwd,
  removeKnownCwd,
  touchKnownCwd,
} from '../../src/config/knownCwds.js';
import type { ReachConfig, KnownCwd } from '../../src/config/config.js';

// ─── fs/promises mock (for validatePath) ────────────────────────────────────

const mockStat = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    stat: (...args: unknown[]) => mockStat(...args),
  };
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const T1 = '2024-01-01T00:00:00.000Z';
const T2 = '2024-01-02T00:00:00.000Z';
const T3 = '2024-01-03T00:00:00.000Z';

// Platform-neutral absolute paths used across tests
const ABS_PATH = process.platform === 'win32' ? 'C:\\git\\repo' : '/home/user/repo';
const ABS_PATH2 = process.platform === 'win32' ? 'C:\\git\\other' : '/home/user/other';
const SHARED_PATH = process.platform === 'win32' ? 'C:\\shared' : '/shared';

function emptyConfig(): ReachConfig {
  return {};
}

function configWith(cwds: KnownCwd[]): ReachConfig {
  return { knownCwds: cwds };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── validateAlias ────────────────────────────────────────────────────────────

describe('validateAlias', () => {
  describe('valid cases → ok: true', () => {
    it.each([
      'reach',
      'my-repo',
      'r1',
      'A',
      '1',
      '1abc',
      'My_Repo-2',
      'a'.repeat(32),
    ])('%s', (alias) => {
      expect(validateAlias(alias)).toEqual({ ok: true });
    });
  });

  describe('invalid cases → ok: false with reason', () => {
    it('empty string', () => {
      const r = validateAlias('');
      expect(r.ok).toBe(false);
    });

    it('33 characters (exceeds max)', () => {
      expect(validateAlias('a'.repeat(33)).ok).toBe(false);
    });

    it('starts with hyphen', () => {
      expect(validateAlias('-repo').ok).toBe(false);
    });

    it('starts with underscore', () => {
      expect(validateAlias('_repo').ok).toBe(false);
    });

    it('contains space', () => {
      expect(validateAlias('my repo').ok).toBe(false);
    });

    it('contains forward slash', () => {
      expect(validateAlias('my/repo').ok).toBe(false);
    });

    it('contains dot', () => {
      expect(validateAlias('my.repo').ok).toBe(false);
    });

    it('--cwd (reserved-looking, starts with hyphen)', () => {
      expect(validateAlias('--cwd').ok).toBe(false);
    });

    it('unicode body (réach)', () => {
      expect(validateAlias('réach').ok).toBe(false);
    });

    it('unicode start (☃repo)', () => {
      expect(validateAlias('☃repo').ok).toBe(false);
    });
  });

  it('invalid result has a non-empty reason string', () => {
    const r = validateAlias('') as { ok: false; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ─── validatePath ─────────────────────────────────────────────────────────────

describe('validatePath', () => {
  it('null byte → invalid (reason mentions null byte)', async () => {
    const r = await validatePath('/valid/path\x00extra');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/null byte/i);
  });

  it('relative path → invalid (reason mentions absolute)', async () => {
    const r = await validatePath('src/relative');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/absolute/i);
  });

  it.skipIf(process.platform !== 'win32')(
    'UNC path on Windows (\\\\server\\share) → invalid',
    async () => {
      const r = await validatePath('\\\\server\\share');
      expect(r.ok).toBe(false);
      expect((r as { ok: false; reason: string }).reason).toMatch(/UNC/i);
    },
  );

  it('valid absolute path, stat returns dir → ok with normalized path', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    const r = await validatePath(ABS_PATH);
    expect(r.ok).toBe(true);
    expect((r as { ok: true; normalized: string }).normalized).toBe(
      nodePath.resolve(ABS_PATH),
    );
  });

  it('trailing path separator is normalized away', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    const withTrailing = ABS_PATH + nodePath.sep;
    const r = await validatePath(withTrailing);
    expect(r.ok).toBe(true);
    expect((r as { ok: true; normalized: string }).normalized).toBe(
      nodePath.resolve(ABS_PATH),
    );
  });

  it('path does not exist (stat throws) → invalid', async () => {
    mockStat.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const r = await validatePath(ABS_PATH);
    expect(r.ok).toBe(false);
  });

  it('path is a file, not a directory → invalid', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    const r = await validatePath(ABS_PATH);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/directory/i);
  });

  it('symlinked directory (stat follows symlink, returns dir) → ok', async () => {
    // fs.stat follows symlinks; validatePath uses stat (not lstat),
    // so a symlink pointing at a directory is accepted.
    mockStat.mockResolvedValue({ isDirectory: () => true });
    const r = await validatePath(ABS_PATH);
    expect(r.ok).toBe(true);
  });
});

// ─── listKnownCwds ────────────────────────────────────────────────────────────

describe('listKnownCwds', () => {
  it('empty config → []', () => {
    expect(listKnownCwds(emptyConfig())).toEqual([]);
  });

  it('config.knownCwds absent (has other fields) → treated as empty', () => {
    expect(listKnownCwds({ telegramChatId: 1 })).toEqual([]);
  });

  it('sorts by lastUsedAt descending', () => {
    const config = configWith([
      { alias: 'a', path: ABS_PATH, addedAt: T1, lastUsedAt: T2 },
      { alias: 'b', path: ABS_PATH2, addedAt: T1, lastUsedAt: T3 },
    ]);
    const result = listKnownCwds(config);
    expect(result[0]!.alias).toBe('b'); // T3 > T2
    expect(result[1]!.alias).toBe('a');
  });

  it('lastUsedAt tie → sort by alias ascending', () => {
    const config = configWith([
      { alias: 'z', path: ABS_PATH, addedAt: T1, lastUsedAt: T2 },
      { alias: 'a', path: ABS_PATH2, addedAt: T1, lastUsedAt: T2 },
    ]);
    const result = listKnownCwds(config);
    expect(result[0]!.alias).toBe('a');
    expect(result[1]!.alias).toBe('z');
  });

  it('entries without lastUsedAt sort after entries that have one', () => {
    const config = configWith([
      { alias: 'no-used', path: ABS_PATH2, addedAt: T1 },
      { alias: 'with-used', path: ABS_PATH, addedAt: T1, lastUsedAt: T2 },
    ]);
    const result = listKnownCwds(config);
    expect(result[0]!.alias).toBe('with-used');
    expect(result[1]!.alias).toBe('no-used');
  });

  it('multiple entries without lastUsedAt → sorted by alias asc among themselves', () => {
    const config = configWith([
      { alias: 'z', path: ABS_PATH2, addedAt: T1 },
      { alias: 'a', path: ABS_PATH, addedAt: T1 },
    ]);
    const result = listKnownCwds(config);
    expect(result[0]!.alias).toBe('a');
    expect(result[1]!.alias).toBe('z');
  });

  it('returns a new array — original config order is preserved', () => {
    const origFirst = { alias: 'b', path: ABS_PATH2, addedAt: T1 };
    const origSecond = { alias: 'a', path: ABS_PATH, addedAt: T1 };
    const config = configWith([origFirst, origSecond]);
    listKnownCwds(config); // sort in a returned array, not in-place
    expect(config.knownCwds![0]!.alias).toBe('b'); // original untouched
  });
});

// ─── getKnownCwdByAlias ───────────────────────────────────────────────────────

describe('getKnownCwdByAlias', () => {
  const entry: KnownCwd = { alias: 'reach', path: ABS_PATH, addedAt: T1 };
  const config = configWith([entry]);

  it('exact match → returns the entry', () => {
    expect(getKnownCwdByAlias(config, 'reach')).toEqual(entry);
  });

  it('miss → returns undefined', () => {
    expect(getKnownCwdByAlias(config, 'unknown')).toBeUndefined();
  });

  it('case-sensitive: Reach ≠ reach → undefined', () => {
    expect(getKnownCwdByAlias(config, 'Reach')).toBeUndefined();
  });

  it('case-sensitive: REACH ≠ reach → undefined', () => {
    expect(getKnownCwdByAlias(config, 'REACH')).toBeUndefined();
  });

  it('empty config → undefined', () => {
    expect(getKnownCwdByAlias(emptyConfig(), 'reach')).toBeUndefined();
  });
});

// ─── getKnownCwdByPath ────────────────────────────────────────────────────────

describe('getKnownCwdByPath', () => {
  // Store the path as resolve() returns it (same format as addKnownCwd does).
  const storedPath = nodePath.resolve(ABS_PATH);
  const entry: KnownCwd = { alias: 'repo', path: storedPath, addedAt: T1 };
  const config = configWith([entry]);

  it('exact match → returns the entry', () => {
    expect(getKnownCwdByPath(config, ABS_PATH)).toEqual(entry);
  });

  it('miss → returns undefined', () => {
    expect(getKnownCwdByPath(config, ABS_PATH2)).toBeUndefined();
  });

  it('empty config → undefined', () => {
    expect(getKnownCwdByPath(emptyConfig(), ABS_PATH)).toBeUndefined();
  });

  it('trailing separator normalized: input with sep finds stored path without it', () => {
    const withTrailing = ABS_PATH + nodePath.sep;
    expect(getKnownCwdByPath(config, withTrailing)).toEqual(entry);
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows: case-insensitive — upper-cased input finds lower-cased stored path',
    () => {
      const upperInput = ABS_PATH.toUpperCase();
      expect(getKnownCwdByPath(config, upperInput)).toEqual(entry);
    },
  );

  it('non-Windows behavior (mocked platform): case-sensitive — different case → miss', () => {
    // Mock process.platform to simulate Linux behavior. nodePath.resolve still
    // runs with the host OS logic but the *comparison* mode switches to case-sensitive.
    const platformGetter = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux' as NodeJS.Platform);
    try {
      // Use same-OS paths so path.resolve produces the same string we stored.
      // The Linux-mode guard uses strict equality — different case must miss.
      const storedPathLower = ABS_PATH.toLowerCase();
      const lookupUpper = ABS_PATH.toUpperCase();
      const linuxEntry: KnownCwd = { alias: 'repo', path: storedPathLower, addedAt: T1 };
      const linuxConfig = configWith([linuxEntry]);
      expect(getKnownCwdByPath(linuxConfig, lookupUpper)).toBeUndefined();
    } finally {
      platformGetter.mockRestore();
    }
  });
});

// ─── addKnownCwd ──────────────────────────────────────────────────────────────

describe('addKnownCwd', () => {
  it('happy path: appends entry to a new config', () => {
    const result = addKnownCwd(emptyConfig(), 'reach', ABS_PATH, T1);
    expect(result.knownCwds).toHaveLength(1);
    const e = result.knownCwds![0]!;
    expect(e.alias).toBe('reach');
    expect(e.addedAt).toBe(T1);
    expect(e.lastUsedAt).toBeUndefined();
  });

  it('stored path is normalized via path.resolve (trailing sep removed)', () => {
    const withTrailing = ABS_PATH + nodePath.sep;
    const result = addKnownCwd(emptyConfig(), 'reach', withTrailing, T1);
    expect(result.knownCwds![0]!.path).toBe(nodePath.resolve(ABS_PATH));
  });

  it('alias collision → throws (message mentions alias name)', () => {
    const config = configWith([{ alias: 'reach', path: ABS_PATH, addedAt: T1 }]);
    expect(() => addKnownCwd(config, 'reach', ABS_PATH2, T2)).toThrow(/reach/i);
  });

  it('invalid alias → throws (message mentions invalid alias)', () => {
    expect(() => addKnownCwd(emptyConfig(), '-bad', ABS_PATH, T1)).toThrow(
      /invalid alias/i,
    );
  });

  it('original config is NOT mutated', () => {
    const original = emptyConfig();
    addKnownCwd(original, 'reach', ABS_PATH, T1);
    expect(original.knownCwds).toBeUndefined();
  });

  it('same path under two different aliases → both allowed (no path dedup)', () => {
    const cfg1 = addKnownCwd(emptyConfig(), 'a', SHARED_PATH, T1);
    const cfg2 = addKnownCwd(cfg1, 'b', SHARED_PATH, T1);
    expect(cfg2.knownCwds).toHaveLength(2);
    const normalizedShared = nodePath.resolve(SHARED_PATH);
    expect(cfg2.knownCwds!.every((c) => c.path === normalizedShared)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows case collision: C:\\Shared and C:\\shared are different aliases → both stored',
    () => {
      // The helpers do NOT deduplicate by case-normalized path.
      // Kat confirmed: no path uniqueness constraint, only alias uniqueness.
      const cfg1 = addKnownCwd(emptyConfig(), 'upper', 'C:\\Shared', T1);
      const cfg2 = addKnownCwd(cfg1, 'lower', 'C:\\shared', T1);
      expect(cfg2.knownCwds).toHaveLength(2);
    },
  );
});

// ─── removeKnownCwd ───────────────────────────────────────────────────────────

describe('removeKnownCwd', () => {
  const entry1: KnownCwd = { alias: 'a', path: ABS_PATH, addedAt: T1 };
  const entry2: KnownCwd = { alias: 'b', path: ABS_PATH2, addedAt: T1 };

  it('removes the matching alias, keeps others', () => {
    const result = removeKnownCwd(configWith([entry1, entry2]), 'a');
    expect(result.knownCwds).toHaveLength(1);
    expect(result.knownCwds![0]!.alias).toBe('b');
  });

  it('missing alias → returns the SAME config reference (no-op)', () => {
    const config = configWith([entry1]);
    expect(removeKnownCwd(config, 'nonexistent')).toBe(config);
  });

  it('empty config → same reference returned', () => {
    const config = emptyConfig();
    expect(removeKnownCwd(config, 'anything')).toBe(config);
  });

  it('original config not mutated on hit', () => {
    const original = configWith([entry1, entry2]);
    removeKnownCwd(original, 'a');
    expect(original.knownCwds).toHaveLength(2);
  });
});

// ─── touchKnownCwd ────────────────────────────────────────────────────────────

describe('touchKnownCwd', () => {
  it('updates lastUsedAt for the matching alias', () => {
    const config = configWith([{ alias: 'reach', path: ABS_PATH, addedAt: T1 }]);
    const result = touchKnownCwd(config, 'reach', T2);
    expect(result.knownCwds![0]!.lastUsedAt).toBe(T2);
  });

  it('only the matching entry is updated — others untouched', () => {
    const config = configWith([
      { alias: 'a', path: ABS_PATH, addedAt: T1 },
      { alias: 'b', path: ABS_PATH2, addedAt: T1 },
    ]);
    const result = touchKnownCwd(config, 'a', T2);
    expect(result.knownCwds![0]!.lastUsedAt).toBe(T2);
    expect(result.knownCwds![1]!.lastUsedAt).toBeUndefined();
  });

  it('missing alias → returns the SAME config reference (no-op)', () => {
    const config = configWith([{ alias: 'reach', path: ABS_PATH, addedAt: T1 }]);
    expect(touchKnownCwd(config, 'unknown', T2)).toBe(config);
  });

  it('original config not mutated', () => {
    const config = configWith([{ alias: 'reach', path: ABS_PATH, addedAt: T1 }]);
    touchKnownCwd(config, 'reach', T2);
    expect(config.knownCwds![0]!.lastUsedAt).toBeUndefined();
  });
});
