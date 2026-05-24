/**
 * ADR-9 Permission Prompting — Category 2: AbortSignal Cancellation.
 *
 * The no-timeout invariant (ADR-9 §7, Branch A) means permission prompts wait
 * indefinitely for an explicit human decision — OR until the session disconnects.
 * Session disconnect aborts all in-flight prompts via the internal AbortController
 * that _wirePermissionHandlers attaches to the `session.disconnected` bridge event.
 *
 * KEY TEST: C2-01 — disconnect fires _sessionAbortController.abort() within ONE
 * event loop turn of emitDisconnected(). This is the behavioral proof of the
 * no-timeout safety invariant: humans can walk away for any length of time; the
 * prompt stays open until they return OR the session ends.
 *
 * Per Kat's reconciliation: drive abort via `fakeBridge.emitDisconnected(sessionId)`,
 * NOT by grabbing _sessionAbortController directly (it's private and intentionally so).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-abort-1';
const REQUEST_ID = 'req-abort-abc';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A permission callback that hangs indefinitely until its signal fires,
 * at which point it resolves `false` (deny). Mirrors what promptUserForPermission
 * does: no throw on abort, just resolves false.
 */
function makePendingCallback(): {
  callback: (toolName: string, args: string, signal?: AbortSignal) => Promise<boolean>;
  hasFired: () => boolean;
} {
  let fired = false;
  const callback = vi.fn((_toolName: string, _args: string, signal?: AbortSignal) => {
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        fired = true;
        resolve(false);
        return;
      }
      signal?.addEventListener('abort', () => {
        fired = true;
        resolve(false);
      }, { once: true });
    });
  });
  return { callback, hasFired: () => fired };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Category 2: AbortSignal Cancellation ────────────────────────────────────

describe('C2 — AbortSignal cancellation', () => {
  /**
   * C2-01 (KEYSTONE): The single most load-bearing test in the catalog.
   *
   * Behavioral proof of the no-timeout safety invariant:
   *   1. A permission.request arrives → the callback is awaiting user input.
   *   2. Session disconnects (bridge emits session.disconnected).
   *   3. The internal AbortController fires within ONE event loop turn.
   *   4. The pending callback resolves false → sendPermissionResponseFn('deny') called.
   *
   * This test is the guard against any re-introduction of a wait loop that might
   * stall cleanup on disconnect.
   */
  it('C2-01 (KEYSTONE): session.disconnected fires within one event loop turn and resolves pending prompt as deny', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const { callback } = makePendingCallback();

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    // Trigger permission.request — callback is now pending, waiting for signal.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-k', 'bash', '{}');
    // Let _handlePermissionRequest reach `await permissionCallback(...)`.
    await flush();

    // Callback is pending — no response yet.
    expect(sendResponseFn).not.toHaveBeenCalled();

    // Session disconnects — _sessionAbortController.abort() fires synchronously.
    bridge.emitDisconnected(SESSION_ID);

    // Within ONE event loop turn (one flush), the pending callback resolves false
    // and sendPermissionResponseFn('deny') is called.
    await flush();

    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, 'perm-k', 'deny');
  });

  it('C2-02: session.disconnected calls sendPermissionResponseFn("deny") for every in-flight prompt', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const { callback } = makePendingCallback();

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-1', 'bash', '{"a":1}');
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-2', 'powershell', '{"b":2}');
    await flush();

    expect(sendResponseFn).not.toHaveBeenCalled();

    bridge.emitDisconnected(SESSION_ID);
    await flush();

    // Both prompts must be denied.
    expect(sendResponseFn).toHaveBeenCalledTimes(2);
    const calls = sendResponseFn.mock.calls as [string, string, string][];
    expect(calls.every(([, , decision]) => decision === 'deny')).toBe(true);
  });

  it('C2-03: if the session is already disconnected when permission.request arrives, the prompt aborts immediately', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const { callback } = makePendingCallback();

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    // Disconnect first.
    bridge.emitDisconnected(SESSION_ID);
    await flush();

    // After disconnect, the permission.request listener has been self-removed.
    // Emitting now should not trigger the callback at all.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-late', 'bash', '{}');
    await flush();

    expect(callback).not.toHaveBeenCalled();
    // The only denial (if any) would be from any prior in-flight prompt; here there was none.
    expect(sendResponseFn).not.toHaveBeenCalled();
  });

  it('C2-04: permission.cancelled fires AbortController only for that permId; sibling prompt remains open', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    let resolveB!: (approved: boolean) => void;

    const callbackFn = vi.fn((_toolName: string, _args: string, signal?: AbortSignal) => {
      return new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => resolve(false), { once: true });
        // Store the resolve for perm-B so we can manually complete it later.
        resolveB = resolve;
      });
    });

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callbackFn,
      sendPermissionResponseFn: sendResponseFn,
    });

    const PERM_A = 'perm-cancel-A';
    const PERM_B = 'perm-cancel-B';

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_A, 'bash', '{}');
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_B, 'powershell', '{}');
    await flush();

    // Cancel only perm-A.
    bridge.emitPermissionCancelled(SESSION_ID, PERM_A);
    await flush();

    // perm-A → denied; perm-B → still pending.
    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_A, 'deny');
    sendResponseFn.mockClear();

    // perm-B is still open — resolve it manually.
    resolveB(true);
    await flush();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_B, 'allow');
  });

  it('C2-05: concurrent prompts on disconnect both resolve "deny" simultaneously', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const { callback } = makePendingCallback();

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    const PERMS = ['perm-x1', 'perm-x2', 'perm-x3'];
    for (const permId of PERMS) {
      bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, permId, 'bash', '{}');
    }
    await flush();

    bridge.emitDisconnected(SESSION_ID);
    await flush();

    expect(sendResponseFn).toHaveBeenCalledTimes(3);
    const calls = sendResponseFn.mock.calls as [string, string, string][];
    for (const permId of PERMS) {
      expect(calls.some(([sid, pid, dec]) => sid === SESSION_ID && pid === permId && dec === 'deny')).toBe(true);
    }
  });

  it('C2-06: permission listeners are removed from the bridge immediately on session.disconnected (self-cleanup)', async () => {
    const bridge = new FakeBridge();
    makePermSessionInline(bridge, SESSION_ID);

    // Three listeners registered.
    expect(bridge.onCalls.filter((c) => c.event === 'permission.request')).toHaveLength(1);
    expect(bridge.onCalls.filter((c) => c.event === 'permission.cancelled')).toHaveLength(1);
    expect(bridge.onCalls.filter((c) => c.event === 'session.disconnected')).toHaveLength(1);

    bridge.emitDisconnected(SESSION_ID);
    await flush();

    // All three removed.
    expect(bridge.offCalls.filter((c) => c.event === 'permission.request')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'permission.cancelled')).toHaveLength(1);
    expect(bridge.offCalls.filter((c) => c.event === 'session.disconnected')).toHaveLength(1);
  });
});

// ─── Private helper ───────────────────────────────────────────────────────────

function makePermSessionInline(bridge: FakeBridge, sessionId: string) {
  const { callback } = makePendingCallback();
  return new BridgeSession(bridge, sessionId, () => REQUEST_ID, {
    permissionCallback: callback,
    sendPermissionResponseFn: vi.fn(),
  });
}
