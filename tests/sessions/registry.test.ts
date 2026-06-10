import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionRegistry } from '../../src/sessions/registry.js';
import type { SessionEntry } from '../../src/sessions/registry.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

let uniqueId = 0;
function tmpPath() {
  return path.join(os.tmpdir(), `reach-registry-test-${Date.now()}-${++uniqueId}.json`);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('SessionRegistry', () => {
  let storePath: string;
  let registry: SessionRegistry;

  beforeEach(() => {
    storePath = tmpPath();
    registry = new SessionRegistry(storePath);
  });

  afterEach(async () => {
    await fs.rm(storePath, { force: true });
    // Clean up any .corrupt.* backup files left by recovery tests
    const dir = path.dirname(storePath);
    const base = path.basename(storePath);
    try {
      const files = await fs.readdir(dir);
      await Promise.all(
        files
          .filter((f) => f.startsWith(base + '.corrupt.'))
          .map((f) => fs.rm(path.join(dir, f), { force: true })),
      );
    } catch { /* dir may not exist */ }
  });

  // ── register / resolve ──────────────────────────────────────────────────────

  describe('register + resolve', () => {
    it('resolves a registered entry by threadId', async () => {
      await registry.register('42', '-100', 'reach-myapp');
      const entry = registry.resolve('42');
      expect(entry).toBeDefined();
      expect(entry?.sessionName).toBe('reach-myapp');
      expect(entry?.threadId).toBe('42');
      expect(entry?.channelId).toBe('-100');
    });

    it('returns undefined for an unregistered threadId', () => {
      expect(registry.resolve('999')).toBeUndefined();
    });

    it('overwrites an existing entry when re-registering the same threadId', async () => {
      await registry.register('42', '-100', 'first-session');
      await registry.register('42', '-100', 'second-session');
      expect(registry.resolve('42')?.sessionName).toBe('second-session');
    });

    it('stores a createdAt ISO timestamp on registration', async () => {
      const before = Date.now();
      await registry.register('1', '-1', 'ts-test');
      const after = Date.now();
      const ts = new Date(registry.resolve('1')!.createdAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('defaults cwd to the daemon working directory on registration', async () => {
      await registry.register('42', '-100', 'cwd-default');
      expect(registry.resolve('42')?.cwd).toBe(process.cwd());
    });

    it('stores an explicit cwd on registration', async () => {
      await registry.register('43', '-100', 'cwd-explicit', undefined, 'D:\\git\\verbose-invention');
      expect(registry.resolve('43')?.cwd).toBe('D:\\git\\verbose-invention');
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered entries', async () => {
      await registry.register('1', '-100', 'alpha');
      await registry.register('2', '-100', 'beta');
      const names = registry.list().map((e: SessionEntry) => e.sessionName).sort();
      expect(names).toEqual(['alpha', 'beta']);
    });

    it('reflects the current state after registration and removal', async () => {
      await registry.register('1', '-100', 'alpha');
      await registry.register('2', '-100', 'beta');
      await registry.remove('1');
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].sessionName).toBe('beta');
    });
  });

  // ── remove ──────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('returns true and removes the entry', async () => {
      await registry.register('42', '-100', 'to-remove');
      const result = await registry.remove('42');
      expect(result).toBe(true);
      expect(registry.resolve('42')).toBeUndefined();
    });

    it('returns false when the threadId was not registered', async () => {
      const result = await registry.remove('9999');
      expect(result).toBe(false);
    });
  });

  // ── persistence ─────────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists state so a fresh registry can reload it', async () => {
      await registry.register('1', '-100', 'alpha');
      await registry.register('2', '-200', 'beta');

      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();

      expect(reloaded.resolve('1')?.sessionName).toBe('alpha');
      expect(reloaded.resolve('2')?.sessionName).toBe('beta');
      expect(reloaded.list()).toHaveLength(2);
    });

    it('does not throw on load when the persist file does not exist (first run)', async () => {
      const fresh = new SessionRegistry(tmpPath()); // no file written
      await expect(fresh.load()).resolves.not.toThrow();
      expect(fresh.list()).toEqual([]);
    });

    it('reflects removals after a reload round-trip', async () => {
      await registry.register('1', '-100', 'alpha');
      await registry.register('2', '-100', 'beta');
      await registry.remove('1');

      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();

      expect(reloaded.resolve('1')).toBeUndefined();
      expect(reloaded.resolve('2')?.sessionName).toBe('beta');
    });

    it('persists automatically on register (without explicit persist call)', async () => {
      // register() calls persist() internally
      await registry.register('7', '-100', 'auto-persist');
      const raw = await fs.readFile(storePath, 'utf-8');
      const data = JSON.parse(raw);
      expect(Object.keys(data.entries)).toContain('7');
    });

    it('round-trips AFK mode fields and lastTopicId through persistence', async () => {
      await registry.upsert({
        sessionName: 'afk-session',
        threadId: '77',
        channelId: '-100',
        createdAt: '2026-05-24T23:19:14-07:00',
        cwd: 'D:\\git\\verbose-invention',
        mode: 'afk',
        afkSince: '2026-05-24T23:19:14-07:00',
        lastTopicId: '77',
      });

      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();
      const entry = reloaded.resolve('77');

      expect(entry?.cwd).toBe('D:\\git\\verbose-invention');
      expect(entry?.mode).toBe('afk');
      expect(entry?.afkSince).toBe('2026-05-24T23:19:14-07:00');
      expect(entry?.lastTopicId).toBe('77');
    });
  });

  // ── model field persistence ──────────────────────────────────────────────

  describe('model field persistence', () => {
    it('register() with model persists model in entry', async () => {
      await registry.register('99', '-100', 'model-test', 'claude-opus-4.5');
      const entry = registry.resolve('99');
      expect(entry?.model).toBe('claude-opus-4.5');
    });

    it('register() without model does not include model field', async () => {
      await registry.register('100', '-100', 'no-model-test');
      const entry = registry.resolve('100');
      expect(entry?.model).toBeUndefined();
    });

    it('load() reads back model from persisted data', async () => {
      await registry.register('101', '-100', 'persist-model', 'claude-opus-4.6');
      
      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();
      
      const entry = reloaded.resolve('101');
      expect(entry?.model).toBe('claude-opus-4.6');
    });

    it('load() handles legacy entries without model field (backward compat)', async () => {
      const legacy = {
        version: 1,
        entries: {
          '42': {
            sessionName: 'legacy-session',
            topicId: 42,
            chatId: -100,
            createdAt: '2024-01-01T00:00:00.000Z',
            // no model field
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(legacy), 'utf-8');

      await registry.load();
      const entry = registry.resolve('42');
      expect(entry?.sessionName).toBe('legacy-session');
      expect(entry?.model).toBeUndefined();
    });

    it('load() defaults cwd for legacy entries that predate the field', async () => {
      const legacy = {
        version: 1,
        entries: {
          '42': {
            sessionName: 'legacy-cwd-session',
            topicId: 42,
            chatId: -100,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(legacy), 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await registry.load();
        expect(registry.resolve('42')?.cwd).toBe(process.cwd());
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ── hardening / recovery ──────────────────────────────────────────────────

  describe('hardening / recovery', () => {
    it('recovers from corrupt JSON by renaming the file and starting empty', async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, '{{{not json!!!', 'utf-8');

      await expect(registry.load()).resolves.not.toThrow();
      expect(registry.list()).toEqual([]);

      // The corrupt file should have been renamed to *.corrupt.<timestamp>
      const dir = path.dirname(storePath);
      const base = path.basename(storePath);
      const siblings = await fs.readdir(dir);
      const backups = siblings.filter((f) => f.startsWith(base + '.corrupt.'));
      expect(backups.length).toBeGreaterThanOrEqual(1);
    });

    it('starts empty when registry version is unsupported', async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({ version: 99, entries: {} }),
        'utf-8',
      );

      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(registry.load()).resolves.not.toThrow();
        expect(registry.list()).toEqual([]);
        expect(spy).toHaveBeenCalledWith(
          expect.stringContaining('Unsupported registry version'),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('loads legacy files that have no version field (treated as v1)', async () => {
      const legacy = {
        entries: {
          '42': {
            sessionName: 'test',
            topicId: 42,
            chatId: -100,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(legacy), 'utf-8');

      await expect(registry.load()).resolves.not.toThrow();
      expect(registry.list()).toHaveLength(1);
      expect(registry.resolve('42')?.sessionName).toBe('test');
    });

    it('skips entries with invalid shape during load', async () => {
      const bad = {
        version: 1,
        entries: {
          '42': { name: 'old-format' }, // missing required fields
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(bad), 'utf-8');

      await expect(registry.load()).resolves.not.toThrow();
      // Invalid entry should be skipped — registry stays empty
      expect(registry.list()).toEqual([]);
    });

    it('skips a numeric JSON key whose explicit threadId differs (no silent re-keying)', async () => {
      // Regression: the old code had `canonicalKey !== key && String(Number(key)) !== key`
      // which let numeric-looking keys through even when the entry's threadId was different,
      // silently re-keying under the derived threadId and potentially overwriting valid entries.
      const corrupt = {
        version: 1,
        entries: {
          '9001': {
            // Explicit threadId disagrees with the JSON key
            threadId: '9999',
            channelId: '-100',
            sessionName: 'corrupt-session',
            createdAt: '2024-01-01T00:00:00.000Z',
            cwd: '',
          },
          // A real entry already occupying '9999' that must not be overwritten
          '9999': {
            threadId: '9999',
            channelId: '-100',
            sessionName: 'real-session',
            createdAt: '2024-01-01T00:00:00.000Z',
            cwd: '',
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(corrupt), 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await registry.load();
        // The mismatched entry (key '9001', threadId '9999') must be skipped.
        expect(registry.resolve('9001')).toBeUndefined();
        // The real entry at '9999' must not be overwritten.
        expect(registry.resolve('9999')?.sessionName).toBe('real-session');
        expect(registry.list()).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9001'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ── name uniqueness ──────────────────────────────────────────────────────────

  describe('name uniqueness', () => {
    it('allows registering a new unique name on a different topic', async () => {
      await registry.register('1', '-100', 'alpha');
      await expect(registry.register('2', '-100', 'beta')).resolves.not.toThrow();
    });

    it('throws when registering a name already used by a different topic', async () => {
      await registry.register('1', '-100', 'dup-name');
      await expect(registry.register('2', '-100', 'dup-name')).rejects.toThrow(/dup-name/);
    });

    it('allows re-registering the same threadId with a new name (update in-place)', async () => {
      await registry.register('1', '-100', 'name-v1');
      await expect(registry.register('1', '-100', 'name-v2')).resolves.not.toThrow();
      expect(registry.resolve('1')?.sessionName).toBe('name-v2');
    });

    it('warns about duplicate names found on load but loads all entries', async () => {
      const data = {
        version: 1,
        entries: {
          '1': { sessionName: 'dup', topicId: 1, chatId: -100, createdAt: '2024-01-01T00:00:00.000Z' },
          '2': { sessionName: 'dup', topicId: 2, chatId: -100, createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await registry.load();
        expect(registry.list()).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/[Dd]uplicate.*dup|dup.*[Dd]uplicate/));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ── move ─────────────────────────────────────────────────────────────────────

  describe('move', () => {
    it('moves an entry from one topic to another', async () => {
      await registry.register('1', '-100', 'session-a');
      await registry.move('1', '2');
      expect(registry.resolve('1')).toBeUndefined();
      expect(registry.resolve('2')?.sessionName).toBe('session-a');
    });

    it('carries model through on move', async () => {
      await registry.register('1', '-100', 'session-b', 'claude-opus-4.5');
      await registry.move('1', '2');
      expect(registry.resolve('2')?.model).toBe('claude-opus-4.5');
    });

    it('preserves createdAt from the original entry', async () => {
      await registry.register('1', '-100', 'session-c');
      const original = registry.resolve('1')!;
      await registry.move('1', '2');
      expect(registry.resolve('2')?.createdAt).toBe(original.createdAt);
    });

    it('preserves the stored sessionName and channelId — identity cannot be changed by the caller', async () => {
      await registry.register('1', '-100', 'session-orig');
      await registry.move('1', '2');
      expect(registry.resolve('2')?.sessionName).toBe('session-orig');
      expect(registry.resolve('2')?.channelId).toBe('-100');
    });

    it('throws when the source threadId is not registered', async () => {
      await expect(registry.move('999', '2')).rejects.toThrow(/999/);
    });

    it('persists the final state after a successful move', async () => {
      await registry.register('1', '-100', 'session-d');
      await registry.move('1', '2');

      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();

      expect(reloaded.resolve('1')).toBeUndefined();
      expect(reloaded.resolve('2')?.sessionName).toBe('session-d');
    });

    it('leaves in-memory state untouched when persist throws (write-first — no mutation on failure)', async () => {
      await registry.register('1', '-100', 'session-e');

      vi.spyOn(registry as any, 'doPersistEntries').mockRejectedValueOnce(new Error('disk full'));

      await expect(registry.move('1', '2')).rejects.toThrow('disk full');

      // Write-first: entries was never mutated, so old binding is intact and new binding absent
      expect(registry.resolve('1')?.sessionName).toBe('session-e');
      expect(registry.resolve('2')).toBeUndefined();
    });

    it('does not mutate entries before the disk write completes (write-first)', async () => {
      await registry.register('1', '-100', 'session-f');

      let capturedResolveAtPersist: string | undefined;
      vi.spyOn(registry as any, 'doPersistEntries').mockImplementationOnce(async () => {
        // At this point, this.entries must NOT yet be mutated (old key still present)
        capturedResolveAtPersist = registry.resolve('1')?.sessionName;
        // Don't call through — successful fake write
      });

      await registry.move('1', '2');

      // During persist, topic 1 must still have been visible (write-first guarantee)
      expect(capturedResolveAtPersist).toBe('session-f');
      // After move(), the live map reflects the new state
      expect(registry.resolve('1')).toBeUndefined();
      expect(registry.resolve('2')?.sessionName).toBe('session-f');
    });

    // F-C: destination-unbound check inside move() ──────────────────────────

    it('throws when the destination threadId is already bound', async () => {
      await registry.register('1', '-100', 'session-a');
      await registry.register('2', '-100', 'session-b');
      await expect(registry.move('1', '2')).rejects.toThrow(
        /already bound to|[Dd]estination/,
      );
    });

    it('error message from move() names the conflicting session', async () => {
      await registry.register('1', '-100', 'session-a');
      await registry.register('2', '-100', 'session-b');
      await expect(registry.move('1', '2')).rejects.toThrow(/session-b/);
    });

    it('leaves both entries intact when destination is already bound (no mutation)', async () => {
      await registry.register('1', '-100', 'session-a');
      await registry.register('2', '-100', 'session-b');
      await expect(registry.move('1', '2')).rejects.toThrow();

      expect(registry.resolve('1')?.sessionName).toBe('session-a');
      expect(registry.resolve('2')?.sessionName).toBe('session-b');
    });

    // ── concurrency serialization ───────────────────────────────────────────

    it('move() serializes against concurrent register() — register runs only after move completes', async () => {
      await registry.register('1', '-100', 'session-a');

      let resolveMoveGate!: () => void;
      const moveGate = new Promise<void>(r => { resolveMoveGate = r; });
      const executionLog: string[] = [];

      let callIndex = 0;
      const spy = vi.spyOn(registry as any, 'doPersistEntries').mockImplementation(async () => {
        const call = ++callIndex;
        if (call === 1) {
          executionLog.push('move:persist-start');
          await moveGate;
          executionLog.push('move:persist-end');
        } else {
          executionLog.push('register:persist');
        }
      });

      try {
        const moveP = registry.move('1', '2');
        // Drain microtasks so moveOp reaches the doPersistEntries await
        await Promise.resolve();
        await Promise.resolve();

        executionLog.push('register:called');
        const registerP = registry.register('3', '-100', 'session-b');

        resolveMoveGate();
        await Promise.all([moveP, registerP]);

        expect(executionLog).toEqual([
          'move:persist-start',
          'register:called',
          'move:persist-end',
          'register:persist',
        ]);
        // Both changes survive — register() was not clobbered by move()'s swap
        expect(registry.resolve('1')).toBeUndefined();
        expect(registry.resolve('2')?.sessionName).toBe('session-a');
        expect(registry.resolve('3')?.sessionName).toBe('session-b');
      } finally {
        spy.mockRestore();
      }
    });

    it('move() serializes against concurrent remove() — remove runs only after move completes', async () => {
      await registry.register('1', '-100', 'session-a');
      await registry.register('3', '-100', 'session-c');

      let resolveMoveGate!: () => void;
      const moveGate = new Promise<void>(r => { resolveMoveGate = r; });
      const executionLog: string[] = [];

      let callIndex = 0;
      const spy = vi.spyOn(registry as any, 'doPersistEntries').mockImplementation(async () => {
        const call = ++callIndex;
        if (call === 1) {
          executionLog.push('move:persist-start');
          await moveGate;
          executionLog.push('move:persist-end');
        } else {
          executionLog.push('remove:persist');
        }
      });

      try {
        const moveP = registry.move('1', '2');
        await Promise.resolve();
        await Promise.resolve();

        executionLog.push('remove:called');
        const removeP = registry.remove('3');

        resolveMoveGate();
        await moveP;
        const removed = await removeP;

        expect(executionLog).toEqual([
          'move:persist-start',
          'remove:called',
          'move:persist-end',
          'remove:persist',
        ]);
        // Both changes survive — remove() was not lost due to move()'s swap
        expect(registry.resolve('1')).toBeUndefined();
        expect(registry.resolve('2')?.sessionName).toBe('session-a');
        expect(registry.resolve('3')).toBeUndefined();
        expect(removed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('atomic swap: entries reference is replaced whole — readers see consistent state during and after move()', async () => {
      await registry.register('1', '-100', 'session-a');

      let stateAtPersistTime: { has1: boolean; has2: boolean } | null = null;

      const spy = vi.spyOn(registry as any, 'doPersistEntries').mockImplementation(async () => {
        // Capture in-memory state at persist time — this.entries must still be the old map
        stateAtPersistTime = {
          has1: registry.resolve('1') !== undefined,
          has2: registry.resolve('2') !== undefined,
        };
      });

      try {
        await registry.move('1', '2');

        // During persist, the old map was still in effect (no partial mutation visible)
        expect(stateAtPersistTime).toEqual({ has1: true, has2: false });
        // After move(), the reference has been atomically swapped to the new map
        expect(registry.resolve('1')).toBeUndefined();
        expect(registry.resolve('2')?.sessionName).toBe('session-a');
        // list() reflects both halves of the swap simultaneously — never a gap state
        const entries = registry.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].threadId).toBe('2');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── findAllByName ────────────────────────────────────────────────────────────

  describe('findAllByName', () => {
    it('returns an empty array when no sessions match', async () => {
      await registry.register('1', '-100', 'alpha');
      expect(registry.findAllByName('beta')).toEqual([]);
    });

    it('returns a single-element array for a unique name', async () => {
      await registry.register('1', '-100', 'alpha');
      const results = registry.findAllByName('alpha');
      expect(results).toHaveLength(1);
      expect(results[0].threadId).toBe('1');
    });

    it('returns all entries for legacy duplicate names loaded from disk', async () => {
      const data = {
        version: 1,
        entries: {
          '1': { sessionName: 'dup', topicId: 1, chatId: -100, createdAt: '2024-01-01T00:00:00.000Z' },
          '2': { sessionName: 'dup', topicId: 2, chatId: -100, createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await registry.load();
        const results = registry.findAllByName('dup');
        expect(results).toHaveLength(2);
        const threadIds = results.map((e) => e.threadId).sort();
        expect(threadIds).toEqual(['1', '2']);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('returns an empty array on a fresh registry with no entries', () => {
      expect(registry.findAllByName('anything')).toEqual([]);
    });
  });

  // ── load() empty-id guard ────────────────────────────────────────────────────

  describe('load() empty-id guard', () => {
    it('skips an entry whose threadId and topicId are both absent', async () => {
      const data = {
        version: 1,
        entries: {
          'orphan': {
            sessionName: 'no-thread',
            channelId: '-100',
            createdAt: '2024-01-01T00:00:00.000Z',
            // no threadId, no topicId
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await registry.load();
        expect(registry.list()).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or invalid threadId/channelId'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('skips an entry whose channelId and chatId are both absent', async () => {
      const data = {
        version: 1,
        entries: {
          '99': {
            sessionName: 'no-channel',
            threadId: '99',
            createdAt: '2024-01-01T00:00:00.000Z',
            // no channelId, no chatId
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await registry.load();
        expect(registry.list()).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or invalid threadId/channelId'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does NOT skip a valid legacy entry with numeric topicId/chatId', async () => {
      const data = {
        version: 1,
        entries: {
          '42': {
            sessionName: 'legacy-ok',
            topicId: 42,
            chatId: -100,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      await registry.load();
      const entry = registry.resolve('42');
      expect(entry).toBeDefined();
      expect(entry?.sessionName).toBe('legacy-ok');
      expect(entry?.threadId).toBe('42');
      expect(entry?.channelId).toBe('-100');
    });

    it('omits lastTopicId rather than storing empty string when value is null/missing', async () => {
      const data = {
        version: 1,
        entries: {
          '55': {
            sessionName: 'last-topic-null',
            threadId: '55',
            channelId: '-100',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastTopicId: null,
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      await registry.load();
      const entry = registry.resolve('55');
      expect(entry).toBeDefined();
      expect(entry?.lastTopicId).toBeUndefined();
    });

    it('omits lastTopicId rather than storing empty string when value is an empty string', async () => {
      const data = {
        version: 1,
        entries: {
          '56': {
            sessionName: 'last-topic-empty',
            threadId: '56',
            channelId: '-100',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastTopicId: '',
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      await registry.load();
      const entry = registry.resolve('56');
      expect(entry).toBeDefined();
      expect(entry?.lastTopicId).toBeUndefined();
    });

    it('loads a valid numeric lastTopicId as a string', async () => {
      const data = {
        version: 1,
        entries: {
          '57': {
            sessionName: 'last-topic-numeric',
            threadId: '57',
            channelId: '-100',
            createdAt: '2024-01-01T00:00:00.000Z',
            lastTopicId: 123,
          },
        },
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data), 'utf-8');

      await registry.load();
      const entry = registry.resolve('57');
      expect(entry).toBeDefined();
      expect(entry?.lastTopicId).toBe('123');
    });
  });

  // ── register() / move() terminology ─────────────────────────────────────────

  describe('register() / move() terminology', () => {
    it('register() duplicate-name error says "thread" not "topic"', async () => {
      await registry.register('1', '-100', 'shared-name');
      await expect(registry.register('2', '-100', 'shared-name')).rejects.toThrow(/thread/);
    });

    it('move() unknown-source error says "thread" not "topic"', async () => {
      await expect(registry.move('999', '2')).rejects.toThrow(/thread/);
    });

    it('move() destination-bound error says "thread" not "topic"', async () => {
      await registry.register('1', '-100', 'session-a');
      await registry.register('2', '-100', 'session-b');
      await expect(registry.move('1', '2')).rejects.toThrow(/thread/);
    });
  });

  // ── write-path validation (PR #11 round 6) ───────────────────────────────────

  describe('write-path validation', () => {
    // register() — fail-fast on invalid inputs

    it('register() throws and does not persist when threadId is empty', async () => {
      await expect(registry.register('', '-100', 'bad-thread')).rejects.toThrow(
        /\[registry\].*register bad-thread/,
      );
      expect(registry.list()).toHaveLength(0);
    });

    it('register() throws and does not persist when channelId is empty', async () => {
      await expect(registry.register('42', '', 'bad-channel')).rejects.toThrow(
        /\[registry\].*register bad-channel/,
      );
      expect(registry.list()).toHaveLength(0);
    });

    it('register() with valid threadId and channelId succeeds as before', async () => {
      await expect(registry.register('42', '-100', 'valid-session')).resolves.not.toThrow();
      expect(registry.resolve('42')?.sessionName).toBe('valid-session');
    });

    // move() — fail-fast on invalid destination

    it('move() throws and does not persist when toThreadId is empty', async () => {
      await registry.register('1', '-100', 'session-a');
      await expect(registry.move('1', '')).rejects.toThrow(
        /\[registry\].*move /,
      );
      // Source entry must remain intact — nothing was persisted
      expect(registry.resolve('1')?.sessionName).toBe('session-a');
      expect(registry.resolve('')).toBeUndefined();
    });

    it('move() with a valid toThreadId succeeds as before', async () => {
      await registry.register('1', '-100', 'session-b');
      await expect(registry.move('1', '2')).resolves.not.toThrow();
      expect(registry.resolve('1')).toBeUndefined();
      expect(registry.resolve('2')?.sessionName).toBe('session-b');
    });
  });
});
