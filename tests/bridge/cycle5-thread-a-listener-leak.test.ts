/**
 * Cycle5 Thread A — raceAbortSignals listener cleanup regression test.
 *
 * Reviewer observation: raceAbortSignals() attached 'abort' listeners to the
 * input signals using { signal: controller.signal }; when the combined signal
 * was never aborted (the normal approval/deny path) the controller never
 * aborted, so those listeners remained attached to the session-level
 * AbortSignal — leaking one listener per permission request.
 *
 * Fix: raceAbortSignals() now returns { signal, cleanup }. _handlePermissionRequest
 * invokes cleanup() in finally so the listeners are released on every path.
 *
 * This test verifies the balance: every addEventListener('abort', ...) call made
 * during a normal approval flow must be paired with a removeEventListener('abort',
 * ...) call by the time the flow settles.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

const SESSION_ID = 'sess-cycle5-A';
const REQUEST_ID = 'req-cycle5-A';

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cycle5 Thread A — raceAbortSignals listener cleanup', () => {
  it('removes every abort listener attached to input signals after a normal approval', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const callback = vi.fn().mockResolvedValue(true); // immediate allow

    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    // Drive one full permission request → callback resolves true → 'allow' sent.
    bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, 'perm-1', 'bash', '{}');
    await flush();
    await flush();

    expect(sendResponseFn).toHaveBeenCalledWith(SESSION_ID, 'perm-1', 'allow');

    // The only code paths that add 'abort' listeners to AbortSignal instances in
    // this flow are inside raceAbortSignals (one per input signal). After
    // _handlePermissionRequest.finally runs, every one of those adds must have a
    // matching remove.
    const abortAdds = addSpy.mock.calls.filter(([type]) => type === 'abort').length;
    const abortRemoves = removeSpy.mock.calls.filter(([type]) => type === 'abort').length;

    expect(abortAdds).toBeGreaterThan(0); // sanity: raceAbortSignals did run
    expect(abortRemoves).toBe(abortAdds);
  });

  it('does not leak listeners across many sequential permission requests', async () => {
    const bridge = new FakeBridge();
    const sendResponseFn = vi.fn();
    const callback = vi.fn().mockResolvedValue(false); // immediate deny

    new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID, {
      permissionCallback: callback,
      sendPermissionResponseFn: sendResponseFn,
    });

    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

    // Cycle 25 prompts through the session-level signal.
    for (let i = 0; i < 25; i++) {
      bridge.emitPermissionRequest(SESSION_ID, REQUEST_ID, `perm-${i}`, 'bash', '{}');
      await flush();
      await flush();
    }

    expect(sendResponseFn).toHaveBeenCalledTimes(25);

    const abortAdds = addSpy.mock.calls.filter(([type]) => type === 'abort').length;
    const abortRemoves = removeSpy.mock.calls.filter(([type]) => type === 'abort').length;

    // Balance must hold across many requests — no accumulation.
    expect(abortRemoves).toBe(abortAdds);
  });
});
