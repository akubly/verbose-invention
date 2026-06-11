/**
 * ISessionRegistry contract test — I7-2
 *
 * Verifies that both SessionRegistry (real, disk-persisted) and MemoryAfkRegistry
 * (in-memory test double) honour identical behavioural invariants.
 *
 * Invariants tested:
 *   1. Replace semantics: upsert(entry) → findByName returns exactly entry (no prior fields).
 *   2. Deleted-field clearing: upsert without a field → that field is undefined on next find.
 *   3. findByName for unknown: returns undefined, does not throw.
 *   4. findAllByName for unknown: returns [] (not undefined, not throw).
 *   5. findAllByName replace semantics: two upserts for same name produce exactly one entry.
 *   6. findAllByName mirrors deleted-field semantics.
 *   7. resolve returns entry for known topicId, undefined for unknown.
 *   8. register rejects duplicate name when bound to different topicId (I10-1).
 *   9. move rejects occupied destination topicId (I10-2).
 *
 * History: a merge-vs-replace bug in MemoryAfkRegistry.upsert masked Fix A (commit 293e850)
 * for months — the old `{ ...prior, ...entry }` semantics caused deleted fields (e.g.,
 * lastTopicId cleared by compensatePartialActivation) to silently reappear from the prior
 * registry entry when the in-memory test double was consulted on the retry path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { MemoryAfkRegistry, type AfkSessionFixture } from '../helpers/afkContract.js';
import type { SessionEntry } from '../../src/types.js';

// Minimal interface shared by both implementations for contract testing.
interface RegistryContractSUT {
  upsert(entry: SessionEntry): Promise<void>;
  findByName(name: string): { sessionName: string; lastTopicId?: string; mode?: string } | undefined;
  findAllByName(name: string): Array<{ sessionName: string; lastTopicId?: string; mode?: string }>;
  resolve?(threadId: string): { sessionName: string; lastTopicId?: string; mode?: string } | undefined;
  register?(threadId: string, channelId: string, sessionName: string, model?: string, cwd?: string): Promise<void>;
  move?(fromThreadId: string, toThreadId: string): Promise<void>;
}

const BASE_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  threadId: '9001',
  channelId: '-1001234567890',
  createdAt: '2026-05-24T23:19:14-07:00',
  cwd: 'D:\\git\\verbose-invention',
  lastTopicId: '9001',
  mode: 'afk',
};

describe.each([
  ['SessionRegistry', 'real' as const],
  ['MemoryAfkRegistry', 'memory' as const],
])('ISessionRegistry contract — %s', (_label, variant) => {
  let sut: RegistryContractSUT;
  let tmpDir: string | undefined;

  beforeEach(() => {
    if (variant === 'real') {
      tmpDir = fsSync.mkdtempSync(path.join(process.cwd(), '.registry-test-'));
      // SessionRegistry starts with an empty in-memory map; upsert writes to disk and
      // updates this.entries, so load() is not required for these mutation tests.
      sut = new SessionRegistry(path.join(tmpDir, 'registry.json')) as unknown as RegistryContractSUT;
    } else {
      tmpDir = undefined;
      const reg = new MemoryAfkRegistry();
      sut = {
        async upsert(entry: SessionEntry) {
          await reg.upsert(entry as unknown as AfkSessionFixture);
        },
        findByName(name: string) {
          return reg.findByName(name);
        },
        findAllByName(name: string) {
          return reg.findAllByName(name);
        },
        resolve(threadId: string) {
          return reg.resolveByThreadId(threadId);
        },
        register(threadId: string, channelId: string, sessionName: string, model?: string, cwd?: string) {
          return reg.register(threadId, channelId, sessionName, model, cwd);
        },
        move(fromThreadId: string, toThreadId: string) {
          return reg.move(fromThreadId, toThreadId);
        },
      };
    }
  });

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('findByName returns undefined for unknown name', () => {
    expect(sut.findByName('no-such-session')).toBeUndefined();
  });

  it('upsert replaces: findByName returns the upserted entry fields', async () => {
    await sut.upsert(BASE_ENTRY);
    const result = sut.findByName(BASE_ENTRY.sessionName);
    expect(result).toMatchObject({
      sessionName: BASE_ENTRY.sessionName,
      lastTopicId: BASE_ENTRY.lastTopicId,
      mode: BASE_ENTRY.mode,
    });
  });

  it('upsert without lastTopicId does not resurrect prior lastTopicId (replace, not merge)', async () => {
    // First upsert: entry has lastTopicId set.
    await sut.upsert(BASE_ENTRY);

    // Second upsert: same sessionName, lastTopicId intentionally absent.
    // Simulates Fix A's `delete rolledBack.lastTopicId` before re-upsert.
    const entryWithoutLastTopicId: SessionEntry = { ...BASE_ENTRY };
    delete entryWithoutLastTopicId.lastTopicId;
    await sut.upsert(entryWithoutLastTopicId);

    // Replace semantics: the prior lastTopicId='9001' must NOT survive into the stored entry.
    const result = sut.findByName(BASE_ENTRY.sessionName);
    expect(result?.lastTopicId).toBeUndefined();
  });

  it('findAllByName returns empty array for unknown name', () => {
    expect(sut.findAllByName('no-such-session')).toEqual([]);
  });

  it('findAllByName replace semantics: two upserts for the same sessionName produce exactly one entry', async () => {
    // First upsert: entry with lastTopicId='9001'.
    await sut.upsert(BASE_ENTRY);

    // Second upsert: same sessionName, different lastTopicId.
    const updated = { ...BASE_ENTRY, lastTopicId: '9002' };
    await sut.upsert(updated);

    // Replace semantics: only one entry exists, with the last-written value.
    const results = sut.findAllByName(BASE_ENTRY.sessionName);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionName: BASE_ENTRY.sessionName,
      lastTopicId: '9002',
    });
  });

  it('findAllByName mirrors deleted-field semantics from findByName', async () => {
    // First upsert: entry has lastTopicId set.
    await sut.upsert(BASE_ENTRY);

    // Second upsert: same sessionName, lastTopicId intentionally absent.
    const entryWithoutLastTopicId: SessionEntry = { ...BASE_ENTRY };
    delete entryWithoutLastTopicId.lastTopicId;
    await sut.upsert(entryWithoutLastTopicId);

    // Replace semantics: the prior lastTopicId='9001' must NOT survive.
    const results = sut.findAllByName(BASE_ENTRY.sessionName);
    expect(results).toHaveLength(1);
    expect(results[0]?.lastTopicId).toBeUndefined();
  });

  it('resolve returns entry for known threadId', async () => {
    if (!sut.resolve) {
      return;
    }

    await sut.upsert(BASE_ENTRY);
    const result = sut.resolve(BASE_ENTRY.threadId!);
    expect(result).toMatchObject({
      sessionName: BASE_ENTRY.sessionName,
      lastTopicId: BASE_ENTRY.lastTopicId,
    });
  });

  it('resolve returns undefined for unknown threadId', () => {
    if (!sut.resolve) {
      return;
    }

    expect(sut.resolve('99999')).toBeUndefined();
  });

  it('register rejects duplicate name (different threadId)', async () => {
    if (!sut.register) {
      return;
    }

    await sut.register('1', '-100', 'dup-name');
    await expect(sut.register('2', '-100', 'dup-name')).rejects.toThrow(/dup-name/);
  });

  it('move rejects occupied destination', async () => {
    if (!sut.register || !sut.move) {
      return;
    }

    await sut.register('1', '-100', 'a');
    await sut.register('2', '-100', 'b');
    await expect(sut.move('1', '2')).rejects.toThrow(/already bound|Destination/i);
  });
});
