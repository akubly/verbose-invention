/**
 * ADR-9 Permission Prompting — Category 6: AllowAlwaysStore + Classifier Bypass
 * + Observability Scanner.
 *
 * The allow-always store is the ADR-9 §Q2 architecture seam for Phase 7 "allow once
 * vs allow always" UX. In Phase 6 only the InMemoryAllowAlwaysStore is shipped.
 * These tests cover:
 *
 * C6-01  AllowAlwaysStore hit → auto-approve, no callback invoked
 * C6-02  No store / store miss → callback invoked normally
 * C6-03  InMemoryAllowAlwaysStore.add() then .has() → true (unit)
 * C6-04  Store isolation — two BridgeSessions with separate stores; each has independent state
 * C6-05  InMemoryAllowAlwaysStore freshness — .has() returns false for unadded tool
 * C6-06  Allow-always auto-approve sends 'allow', NOT 'deny'
 * C6-07  Observability scanner — stale prompt warning fires after 10 minutes (setInterval)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { InMemoryAllowAlwaysStore } from '../../src/bridge/allowAlwaysStore.js';
import { promptUserForPermission } from '../../src/bot/prompt.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-bypass-1';
const REQUEST_ID = 'req-bypass-abc';
const PERM_ID = 'perm-bypass-001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Category 6: AllowAlwaysStore + Classifier Bypass + Scanner ───────────────

describe('C6 — AllowAlwaysStore, classifier bypass, and observability scanner', () => {
  it('C6-01: when allow-always store has the tool, auto-approve fires and callback is NOT called', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const permissionCallback = vi.fn().mockResolvedValue(true);

    const store = new InMemoryAllowAlwaysStore();
    store.add('bash');

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback,
      allowAlwaysStore: store,
      sendPermissionResponseFn: sendResponseFn,
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    // Auto-approved — callback should never have been called.
    expect(permissionCallback).not.toHaveBeenCalled();
    expect(sendResponseFn).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  it('C6-02: when allow-always store does not have the tool, callback IS called', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const permissionCallback = vi.fn().mockResolvedValue(true);

    const store = new InMemoryAllowAlwaysStore(); // empty — bash not in it

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback,
      allowAlwaysStore: store,
      sendPermissionResponseFn: sendResponseFn,
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'bash', '{}');
    await flush();

    // Callback was invoked (no bypass).
    expect(permissionCallback).toHaveBeenCalledOnce();
    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, PERM_ID, 'allow');
  });

  it('C6-03: InMemoryAllowAlwaysStore.add() then .has() returns true', () => {
    const store = new InMemoryAllowAlwaysStore();

    expect(store.has('bash')).toBe(false);
    store.add('bash');
    expect(store.has('bash')).toBe(true);

    // Other tools unaffected.
    expect(store.has('powershell')).toBe(false);
    store.add('powershell');
    expect(store.has('powershell')).toBe(true);
    expect(store.has('bash')).toBe(true); // first one still there
  });

  it('C6-04: store isolation — two BridgeSessions with separate stores have independent allow-always state', async () => {
    const bridge = new FakeBridge();
    const responseA = vi.fn();
    const responseB = vi.fn();
    const cbA = vi.fn().mockResolvedValue(true);
    const cbB = vi.fn().mockResolvedValue(true);

    // Session A: store has 'bash' pre-approved.
    const storeA = new InMemoryAllowAlwaysStore();
    storeA.add('bash');
    new BridgeSession(bridge, 'sess-iso-A', () => REQUEST_ID, {
      permissionCallback: cbA,
      allowAlwaysStore: storeA,
      sendPermissionResponseFn: responseA,
    });

    // Session B: fresh store, 'bash' NOT pre-approved.
    const storeB = new InMemoryAllowAlwaysStore();
    new BridgeSession(bridge, 'sess-iso-B', () => REQUEST_ID, {
      permissionCallback: cbB,
      allowAlwaysStore: storeB,
      sendPermissionResponseFn: responseB,
    });

    // Both sessions receive a permission.request for 'bash'.
    bridge.emitPermissionRequest('sess-iso-A', REQUEST_ID, 'perm-A', 'bash', '{}');
    bridge.emitPermissionRequest('sess-iso-B', REQUEST_ID, 'perm-B', 'bash', '{}');
    await flush();

    // Session A: auto-approved (store has 'bash'), callback NOT called.
    expect(cbA).not.toHaveBeenCalled();
    expect(responseA).toHaveBeenCalledWith('sess-iso-A', 'perm-A', 'allow');

    // Session B: callback called (store miss), normal path.
    expect(cbB).toHaveBeenCalledOnce();
    expect(responseB).toHaveBeenCalledWith('sess-iso-B', 'perm-B', 'allow');
  });

  it('C6-05: InMemoryAllowAlwaysStore.has() returns false for a tool that was never added', () => {
    const store = new InMemoryAllowAlwaysStore();

    // Fresh store — nothing was added.
    expect(store.has('bash')).toBe(false);
    expect(store.has('powershell')).toBe(false);
    expect(store.has('edit')).toBe(false);
    expect(store.has('')).toBe(false);
  });

  it('C6-06: allow-always auto-approve sends "allow" (not "deny") — correct decision direction', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();

    const store = new InMemoryAllowAlwaysStore();
    store.add('git_commit');

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: vi.fn().mockResolvedValue(false), // would deny if called
      allowAlwaysStore: store,
      sendPermissionResponseFn: sendResponseFn,
    });

    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, PERM_ID, 'git_commit', '{"msg":"chore: test"}');
    await flush();

    // Decision must be 'allow', not 'deny'. The callback (which would return false) is bypassed.
    const calls = sendResponseFn.mock.calls as [string, string, string][];
    expect(calls[0]![2]).toBe('allow');
  });

  /**
   * C6-07: Observability scanner — passive stale-prompt warning fires after 10 minutes.
   *
   * The scanner is registered lazily on the first call to `promptUserForPermission`.
   * It uses setInterval (NOT setTimeout) and does NOT resolve the prompt.
   * After 10 minutes it emits a console.warn for each prompt still in the registry.
   *
   * Clock starts at 0 (now: 0) so createdAt is predictably 0. After advancing
   * 600 001 ms, Date.now() = 600 001 and 600 001 − 0 > 600 000 triggers the warning.
   * vi.advanceTimersByTimeAsync drains Promise microtasks between timer firings,
   * ensuring the setInterval callback sees the fully-registered prompt.
   */
  it('C6-07: stale-prompt warning scanner emits console.warn after 10 minutes for an open prompt', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Synchronous-ish mock: resolves in the next microtask, no fake-timer dependency.
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 777, chat: { id: -100 } });

    const bot: Parameters<typeof promptUserForPermission>[0] = {
      api: {
        sendMessage,
        editMessageText: vi.fn().mockResolvedValue({ ok: true }),
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      },
      on: vi.fn(),
    } as unknown as Parameters<typeof promptUserForPermission>[0];

    // Start a prompt — ensurePromptRegistry registers the setInterval scanner.
    const controller = new AbortController();
    const pendingDecision = promptUserForPermission(
      bot,
      -100,
      1,
      'bash',
      '{"cmd":"rm -rf /"}',
      controller.signal,
    );

    // Drain the microtask queue: sendMessage resolves → promptUserForPermission
    // resumes → registry.pendingByRequestId.set(requestId, { createdAt: 0, ... }).
    await Promise.resolve();
    await Promise.resolve();

    // Advance fake clock PAST two interval periods so the second firing sees
    // Date.now() = 1 200 001 and 1 200 001 − 0 > 600 000 (strict >).
    // The first firing at t=600 000 produces now − createdAt = 600 000 which
    // is NOT strictly greater than TEN_MINUTES_MS (600 000), so no warn then.
    await vi.advanceTimersByTimeAsync(2 * 10 * 60 * 1000 + 1);

    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls.flat().map(String);
    expect(warnArgs.some((msg) => /10 minutes/i.test(msg))).toBe(true);

    // Cleanup: abort the prompt so the pending Promise resolves.
    controller.abort();
    await Promise.resolve();
    await pendingDecision;
  });
});
