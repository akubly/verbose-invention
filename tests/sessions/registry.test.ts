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
    it('resolves a registered entry by topicId', async () => {
      await registry.register(42, -100, 'reach-myapp');
      const entry = registry.resolve(42);
      expect(entry).toBeDefined();
      expect(entry?.sessionName).toBe('reach-myapp');
      expect(entry?.topicId).toBe(42);
      expect(entry?.chatId).toBe(-100);
    });

    it('returns undefined for an unregistered topicId', () => {
      expect(registry.resolve(999)).toBeUndefined();
    });

    it('overwrites an existing entry when re-registering the same topicId', async () => {
      await registry.register(42, -100, 'first-session');
      await registry.register(42, -100, 'second-session');
      expect(registry.resolve(42)?.sessionName).toBe('second-session');
    });

    it('stores a createdAt ISO timestamp on registration', async () => {
      const before = Date.now();
      await registry.register(1, -1, 'ts-test');
      const after = Date.now();
      const ts = new Date(registry.resolve(1)!.createdAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered entries', async () => {
      await registry.register(1, -100, 'alpha');
      await registry.register(2, -100, 'beta');
      const names = registry.list().map((e: SessionEntry) => e.sessionName).sort();
      expect(names).toEqual(['alpha', 'beta']);
    });

    it('reflects the current state after registration and removal', async () => {
      await registry.register(1, -100, 'alpha');
      await registry.register(2, -100, 'beta');
      await registry.remove(1);
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].sessionName).toBe('beta');
    });
  });

  // ── remove ──────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('returns true and removes the entry', async () => {
      await registry.register(42, -100, 'to-remove');
      const result = await registry.remove(42);
      expect(result).toBe(true);
      expect(registry.resolve(42)).toBeUndefined();
    });

    it('returns false when the topicId was not registered', async () => {
      const result = await registry.remove(9999);
      expect(result).toBe(false);
    });
  });

  // ── persistence ─────────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists state so a fresh registry can reload it', async () => {
      await registry.register(1, -100, 'alpha');
      await registry.register(2, -200, 'beta');

      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();

      expect(reloaded.resolve(1)?.sessionName).toBe('alpha');
      expect(reloaded.resolve(2)?.sessionName).toBe('beta');
      expect(reloaded.list()).toHaveLength(2);
    });

    it('does not throw on load when the persist file does not exist (first run)', async () => {
      const fresh = new SessionRegistry(tmpPath()); // no file written
      await expect(fresh.load()).resolves.not.toThrow();
      expect(fresh.list()).toEqual([]);
    });

    it('reflects removals after a reload round-trip', async () => {
      await registry.register(1, -100, 'alpha');
      await registry.register(2, -100, 'beta');
      await registry.remove(1);

      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();

      expect(reloaded.resolve(1)).toBeUndefined();
      expect(reloaded.resolve(2)?.sessionName).toBe('beta');
    });

    it('persists automatically on register (without explicit persist call)', async () => {
      // register() calls persist() internally
      await registry.register(7, -100, 'auto-persist');
      const raw = await fs.readFile(storePath, 'utf-8');
      const data = JSON.parse(raw);
      expect(Object.keys(data.entries)).toContain('7');
    });
  });

  // ── model field persistence ──────────────────────────────────────────────

  describe('model field persistence', () => {
    it('register() with model persists model in entry', async () => {
      await registry.register(99, -100, 'model-test', 'claude-opus-4.5');
      const entry = registry.resolve(99);
      expect(entry?.model).toBe('claude-opus-4.5');
    });

    it('register() without model does not include model field', async () => {
      await registry.register(100, -100, 'no-model-test');
      const entry = registry.resolve(100);
      expect(entry?.model).toBeUndefined();
    });

    it('load() reads back model from persisted data', async () => {
      await registry.register(101, -100, 'persist-model', 'claude-opus-4.6');
      
      const reloaded = new SessionRegistry(storePath);
      await reloaded.load();
      
      const entry = reloaded.resolve(101);
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
      const entry = registry.resolve(42);
      expect(entry?.sessionName).toBe('legacy-session');
      expect(entry?.model).toBeUndefined();
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
      expect(registry.resolve(42)?.sessionName).toBe('test');
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
  });
});
