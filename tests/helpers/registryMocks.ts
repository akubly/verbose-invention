/**
 * Shared mock factory for ISessionRegistry.
 * Used by tests that register handlers or build controllers and need a
 * minimal in-memory registry stub.
 *
 * Extracted from (and reconciled across):
 *   - tests/bot/handlers.slashGuard.test.ts
 *   - tests/bot/cwdCommand.test.ts
 *   - tests/bot/newCwdFlag.test.ts
 *   - tests/relay/afkMode.slashGuard.test.ts
 *
 * All four copies had identical method sets. The only divergence was that
 * afkMode used resolve: vi.fn() (no map lookup) and list: vi.fn(() => []).
 * With an empty default entries array both are equivalent: map.get() returns
 * undefined for any topicId and Array.from(emptyMap.values()) returns [].
 *
 * Behavioural note: remove() defaults to mockResolvedValue(true) so that
 * "success" tests work without extra per-test mocking.  Tests that need a
 * falsy result (e.g. "no session linked" branches) should call
 * (registry.remove as ReturnType<typeof vi.fn>).mockResolvedValue(false)
 * explicitly.
 */

import { vi } from 'vitest';
import type { ISessionRegistry } from '../../src/sessions/registry.js';
import type { SessionEntry } from '../../src/types.js';

/**
 * Returns a stub ISessionRegistry backed by an in-memory Map.
 * resolve() looks up by topicId; list() returns all entries.
 * All mutating methods (register, upsert, remove, move) are vi.fn() no-ops.
 */
export function makeStubRegistry(entries: SessionEntry[] = []): ISessionRegistry {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return {
    load: vi.fn(),
    register: vi.fn(),
    upsert: vi.fn(),
    resolve: vi.fn((topicId: number) => map.get(topicId)),
    findByName: vi.fn(),
    findAllByName: vi.fn(() => []),
    list: vi.fn(() => Array.from(map.values())),
    remove: vi.fn().mockResolvedValue(true),
    move: vi.fn(),
  } as unknown as ISessionRegistry;
}
