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
  findByName(name: string): { sessionName: string; lastTopicId?: number; mode?: string } | undefined;
}

const BASE_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  topicId: 9001,
  chatId: -1001234567890,
  createdAt: '2026-05-24T23:19:14-07:00',
  cwd: 'D:\\git\\verbose-invention',
  lastTopicId: 9001,
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

    // Replace semantics: the prior lastTopicId=9001 must NOT survive into the stored entry.
    const result = sut.findByName(BASE_ENTRY.sessionName);
    expect(result?.lastTopicId).toBeUndefined();
  });
});
