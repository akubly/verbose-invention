import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
