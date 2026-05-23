/**
 * ADR-9 Permission Prompting — Categories 4 and 5.
 *
 * Category 4: Adversarial / edge cases — unknown permIds, post-disconnect requests,
 *   callback errors, deny-path verification, and classifier unit tests for extension.mjs.
 *
 * Category 5: No-timeout behavioral — Friday→Monday durability (72-hour pending prompt
 *   with no auto-denial) and the no-timer regression assertion (spy on setTimeout to
 *   guard against re-introduction of deleted timeout logic per ADR-9 Branch A).
 *
 * Side-effect guard for extension.mjs:
 *   extension.mjs calls `main().catch(...)` at the top level. The vi.mock calls below
 *   are hoisted by vitest before any import is processed, preventing joinSession() and
 *   createConnection() from running during module load.
 */

// ─── Side-effect guards (MUST be before any import from extension.mjs) ───────
// These are hoisted by vitest's transform above all import statements.

import { vi } from 'vitest';

vi.mock('@github/copilot-sdk/extension', () => ({
  joinSession: vi.fn().mockResolvedValue({
    onPermissionRequest: vi.fn(),
    log: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => ({
    setEncoding: vi.fn(),
    on: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';
// Classifiers are tested below — imported after mocks are established.
import { isDestructive, isKnownSafe } from '../../extension.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-edge-1';
const REQUEST_ID = 'req-edge-abc';
const PERM_ID = 'perm-edge-001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makePermSession(
  bridge: FakeBridge,
  sessionId = SESSION_ID,
  callbackImpl?: (toolName: string, args: string, signal?: AbortSignal) => Promise<boolean>,
) {
  const sendResponseFn = vi.fn();
  const permissionCallback = callbackImpl
    ? vi.fn(callbackImpl)
    : vi.fn().mockResolvedValue(true);

  new BridgeSession(bridge, sessionId, () => REQUEST_ID, {
    permissionCallback,
    sendPermissionResponseFn: sendResponseFn,
  });

  return { sendResponseFn, permissionCallback };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Category 4: Adversarial / Edge ──────────────────────────────────────────

describe('C4 — adversarial / edge cases', () => {
  it('C4-01: permission.cancelled for an unknown permId is a silent no-op (no crash)', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn, permissionCallback } = makePermSession(bridge);

    // No permission.request has been emitted — nothing is pending.
    expect(() => {
      bridge.emitPermissionCancelled(SESSION_ID, 'perm-unknown-xyz');
    }).not.toThrow();

    await flush();

    // Nothing should have been invoked.
    expect(permissionCallback).not.toHaveBeenCalled();
    expect(sendResponseFn).not.toHaveBeenCalled();
  });

  it('C4-02: permission.request arriving after session.disconnected is ignored (listener self-removed)', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn, permissionCallback } = makePermSession(bridge);

    // Disconnect first — permission listener self-removes.
    bridge.emitDisconnected(SESSION_ID);
    await flush();

    // Request arrives after disconnect.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    expect(permissionCallback).not.toHaveBeenCalled();
    expect(sendResponseFn).not.toHaveBeenCalled();
  });

  it('C4-03: when the permission callback throws, sendPermissionResponseFn is called with "deny"', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, () => {
      return Promise.reject(new Error('Telegram API timeout'));
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    // Error is safely contained — extension is never left hanging.
    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'deny');
  });

  it('C4-04: callback resolving false sends "deny" (deny path verified end-to-end)', async () => {
    const bridge = new FakeBridge();
    const { sendResponseFn } = makePermSession(bridge, SESSION_ID, () => Promise.resolve(false));

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'git_commit', '{"msg":"wip"}');
    await flush();

    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'deny');
  });

  it('C4-05: isDestructive() returns true for known destructive tools and false for unknown', () => {
    // Known destructive tools (from extension.mjs DESTRUCTIVE_TOOLS set).
    expect(isDestructive('edit')).toBe(true);
    expect(isDestructive('create')).toBe(true);
    expect(isDestructive('powershell')).toBe(true);
    expect(isDestructive('bash')).toBe(true);
    expect(isDestructive('git_commit')).toBe(true);
    expect(isDestructive('gh_pr_create')).toBe(true);
    expect(isDestructive('gh_issue_create')).toBe(true);

    // Unknown / non-destructive tools.
    expect(isDestructive('read')).toBe(false);
    expect(isDestructive('view')).toBe(false);
    expect(isDestructive('grep')).toBe(false);
    expect(isDestructive('unknown_tool')).toBe(false);
  });

  it('C4-06: isKnownSafe() returns true for safe tools and false for unknown tools', () => {
    // Known safe tools (from extension.mjs SAFE_TOOLS set).
    expect(isKnownSafe('read')).toBe(true);
    expect(isKnownSafe('view')).toBe(true);
    expect(isKnownSafe('grep')).toBe(true);
    expect(isKnownSafe('glob')).toBe(true);
    expect(isKnownSafe('url')).toBe(true);
    expect(isKnownSafe('web_search')).toBe(true);
    expect(isKnownSafe('web_fetch')).toBe(true);

    // Tools not in the safe list.
    expect(isKnownSafe('bash')).toBe(false);
    expect(isKnownSafe('edit')).toBe(false);
    expect(isKnownSafe('unknown_mcp_tool')).toBe(false);
  });
});

// ─── Category 5: No-timeout Behavioral ───────────────────────────────────────

describe('C5 — no-timeout behavioral', () => {
  /**
   * C5-01: Friday → Monday durability.
   *
   * A permission prompt stays open through 72 simulated hours with no auto-denial.
   * After 72 hours the user taps Approve — the prompt resolves correctly.
   * No timers should have been created by BridgeSession's permission handling.
   *
   * Fake timer scope: toFake list excludes setImmediate (readline compat per skill).
   * Since we use FakeBridge (no readline), this is just good practice for consistency.
   */
  it('C5-01: prompt remains open through 72 simulated hours then resolves correctly on demand', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });

    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    let externalResolve!: (approved: boolean) => void;

    const callback = vi.fn((_toolName: string, _args: string, signal?: AbortSignal) => {
      return new Promise<boolean>((resolve) => {
        if (signal?.aborted) { resolve(false); return; }
        signal?.addEventListener('abort', () => resolve(false), { once: true });
        externalResolve = resolve;
      });
    });

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{"cmd":"cleanup"}');

    // Let _handlePermissionRequest reach the `await permissionCallback(...)` park point.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Advance 72 hours (Friday → Monday).
    vi.advanceTimersByTime(72 * 60 * 60 * 1000);

    // No auto-denial should have fired — callback still pending.
    expect(sendResponseFn).not.toHaveBeenCalled();

    // User returns Monday and approves.
    externalResolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  /**
   * C5-02: No-timer regression assertion.
   *
   * Spy on globalThis.setTimeout and verify that BridgeSession._wirePermissionHandlers
   * and _handlePermissionRequest create ZERO setTimeout calls.
   *
   * This is a regression guard per the no-timer-regression-assertion skill:
   * it detects re-introduction of timeout logic that ADR-9 Branch A explicitly removed.
   *
   * NOTE: setInterval is permitted (the observability scanner in prompt.ts uses it).
   *       Only setTimeout is prohibited at the BridgeSession permission-handling call site.
   */
  it('C5-02 (no-timer): BridgeSession permission handling creates zero setTimeout calls', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();

    // Spy BEFORE constructing the session (construction wires the handlers).
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    let externalResolve!: (approved: boolean) => void;
    const callback = vi.fn((_toolName: string, _args: string, _signal?: AbortSignal) => {
      return new Promise<boolean>((resolve) => { externalResolve = resolve; });
    });

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    // Emit permission.request — _handlePermissionRequest starts.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    // Assert: BridgeSession creates NO setTimeout for permission handling.
    // (setInterval is allowed — we only check setTimeout here.)
    expect(setTimeoutSpy.mock.calls).toHaveLength(0);

    // Cleanup: resolve so test exits cleanly.
    externalResolve(false);
    await flush();
  });
});
