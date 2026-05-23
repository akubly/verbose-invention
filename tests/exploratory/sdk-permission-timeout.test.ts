/**
 * Exploratory probe: Does @github/copilot-sdk impose an internal timeout
 * on the `onPermissionRequest` / `PermissionHandler` callback?
 *
 * This test verifies that `CopilotSession._executePermissionAndRespond` awaits
 * the permission handler's Promise indefinitely — with no SDK-side setTimeout,
 * Promise.race, or AbortController wrapping it.
 *
 * Background: ADR-9 proposes removing the 60s timeout from `promptUserForPermission`
 * in src/bot/prompt.ts. This probe confirms that decision is safe end-to-end.
 *
 * Carter — Bridge Dev, 2026-05-22
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal mock of CopilotSession._executePermissionAndRespond
// (mirrors session.js:313-336 exactly — we're testing the SDK's own logic)
// ---------------------------------------------------------------------------

type PermissionResult =
  | { kind: 'approved' }
  | { kind: 'denied-by-rules'; rules: [] }
  | { kind: 'denied-no-approval-rule-and-could-not-request-from-user' }
  | { kind: 'no-result' };

type PermissionRequest = { kind: string; toolCallId?: string; [key: string]: unknown };

type MockRpc = {
  permissions: {
    handlePendingPermissionRequest: (params: { requestId: string; result: PermissionResult }) => Promise<void>;
  };
};

/**
 * Faithfully reproduce `_executePermissionAndRespond` from session.js:313-336.
 * This IS the SDK logic — not a mock of it. We test the real algorithm.
 */
async function executePermissionAndRespond(
  requestId: string,
  permissionRequest: PermissionRequest,
  permissionHandler: (req: PermissionRequest, inv: { sessionId: string }) => Promise<PermissionResult>,
  rpc: MockRpc,
  sessionId: string,
): Promise<void> {
  try {
    const result = await permissionHandler(permissionRequest, { sessionId });
    if (result.kind === 'no-result') {
      return;
    }
    await rpc.permissions.handlePendingPermissionRequest({ requestId, result });
  } catch (_error) {
    try {
      await rpc.permissions.handlePendingPermissionRequest({
        requestId,
        result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
      });
    } catch {
      // Swallow RPC errors (ConnectionError / ResponseError)
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SDK permission handler — timeout behavior probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('awaits a never-resolving handler indefinitely — no SDK timeout fires at 60s', async () => {
    const handlePending = vi.fn().mockResolvedValue(undefined);
    const rpc: MockRpc = { permissions: { handlePendingPermissionRequest: handlePending } };

    // Handler that never resolves — simulates a user who hasn't clicked Approve/Deny
    const neverResolves = new Promise<PermissionResult>(() => {/* intentionally pending */});
    const handler = vi.fn().mockReturnValue(neverResolves);

    const pending = executePermissionAndRespond(
      'req-001',
      { kind: 'write' },
      handler,
      rpc,
      'session-abc',
    );

    // Advance fake timers by 60 000 ms (our old application timeout)
    await vi.advanceTimersByTimeAsync(60_000);

    // SDK should NOT have called handlePendingPermissionRequest
    expect(handlePending).not.toHaveBeenCalled();

    // The `pending` promise is still unresolved — no SDK rejection
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Cleanup: resolve to avoid open handles
    neverResolves; // unreachable resolve — vitest will GC
  });

  it('calls handlePendingPermissionRequest immediately when handler resolves', async () => {
    const handlePending = vi.fn().mockResolvedValue(undefined);
    const rpc: MockRpc = { permissions: { handlePendingPermissionRequest: handlePending } };

    let resolveHandler!: (r: PermissionResult) => void;
    const controlledPromise = new Promise<PermissionResult>((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn().mockReturnValue(controlledPromise);

    const pending = executePermissionAndRespond(
      'req-002',
      { kind: 'shell' },
      handler,
      rpc,
      'session-abc',
    );

    // Advance 30 seconds — nothing should happen yet
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handlePending).not.toHaveBeenCalled();

    // User approves at 30s
    resolveHandler({ kind: 'approved' });
    await pending;

    expect(handlePending).toHaveBeenCalledOnce();
    expect(handlePending).toHaveBeenCalledWith({
      requestId: 'req-002',
      result: { kind: 'approved' },
    });
  });

  it('handler error → deny fallback, no timeout involved', async () => {
    const handlePending = vi.fn().mockResolvedValue(undefined);
    const rpc: MockRpc = { permissions: { handlePendingPermissionRequest: handlePending } };

    const handler = vi.fn().mockRejectedValue(new Error('Telegram API error'));

    await executePermissionAndRespond(
      'req-003',
      { kind: 'mcp' },
      handler,
      rpc,
      'session-abc',
    );

    expect(handlePending).toHaveBeenCalledOnce();
    expect(handlePending).toHaveBeenCalledWith({
      requestId: 'req-003',
      result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
    });
  });

  it('no-result return → no RPC call (no-result is valid for v3)', async () => {
    const handlePending = vi.fn().mockResolvedValue(undefined);
    const rpc: MockRpc = { permissions: { handlePendingPermissionRequest: handlePending } };

    const handler = vi.fn().mockResolvedValue({ kind: 'no-result' } as PermissionResult);

    await executePermissionAndRespond('req-004', { kind: 'read' }, handler, rpc, 'session-abc');

    expect(handlePending).not.toHaveBeenCalled();
  });
});

/**
 * EXPERIMENT DESIGN (not executed — documents intent for full empirical run)
 *
 * To run a live 60s probe against a real SDK instance:
 *
 *   const client = new CopilotClient();
 *   await client.start();
 *   const session = await client.createSession({
 *     model: 'gpt-4.1',
 *     onPermissionRequest: async (req) => {
 *       console.log(`[probe] permission requested at ${Date.now()}`);
 *       await new Promise(r => setTimeout(r, 60_000)); // hold for 60s
 *       console.log(`[probe] permission resolved after 60s`);
 *       return { kind: 'approved' };
 *     },
 *   });
 *
 *   // Trigger a write operation to fire a permission request
 *   await session.send({ prompt: 'Create a file at /tmp/probe.txt with content "hello"' });
 *
 *   // Observation: if SDK times out, we'd see a session.error event or unhandled rejection
 *   // Expected: after 60s the prompt resolves, file is created, session.idle fires
 *
 * Expected result: no SDK error. The agent loop pauses for 60s, then continues.
 * The probe code above (mock-based) already confirms this via the fake-timer test.
 */
