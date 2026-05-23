/**
 * bridgeSession.ts — Adapter: ExtensionBridge → CopilotSession.
 *
 * BridgeSession wraps the push-based bridge event model (stream / stream.error)
 * into the AsyncIterable<string> contract that relay.ts expects, so the relay's
 * 800ms throttle, accumulation cap, MarkdownV2 fallback, and error handling
 * all apply to bridge-backed sessions without any changes to relay.ts (ADR-8, Option A).
 *
 * Listener cleanup is guaranteed via try/finally: bridge.off() fires on normal
 * completion, on error, and if the consumer abandons the iterator early.
 *
 * ADR-9: When permOptions are provided, BridgeSession wires the permission
 * control-plane: incoming permission.request messages are forwarded to the
 * PermissionPromptCallback (which triggers a Telegram inline keyboard). The
 * user's decision is sent back as a permission.response. Session disconnect
 * aborts all pending prompts via AbortSignal.
 */

import type { BridgeEmitter } from './extensionBridge.js';
import type { CopilotSession } from '../copilot/factory.js';
import type { PermissionPromptCallback } from '../copilot/factory.js';
import type { AllowAlwaysStore } from './allowAlwaysStore.js';

type QueueItem =
  | { kind: 'chunk'; value: string }
  | { kind: 'done' }
  | { kind: 'error'; err: Error };

/** Allowlist regex for tool names received from the extension over the named pipe. */
const TOOL_NAME_VALID_RE = /^[a-z_][a-z0-9_.:-]{0,127}$/i;

/** Maximum tool name length retained after sanitization. */
const TOOL_NAME_MAX_LENGTH = 128;

/**
 * Sanitize a toolName that arrived from an untrusted extension.
 *
 * If the name matches the allowlist it is returned unchanged.
 * Otherwise every disallowed character (including RTL overrides, null bytes,
 * homoglyphs, and any non-ASCII) is replaced with '_', the result is
 * truncated to TOOL_NAME_MAX_LENGTH, and a warning is emitted so the anomaly
 * is observable in daemon logs.
 */
function sanitizeToolName(toolName: string): string {
  if (TOOL_NAME_VALID_RE.test(toolName)) {
    return toolName;
  }
  const sanitized = toolName
    .slice(0, TOOL_NAME_MAX_LENGTH)
    .replace(/[^A-Za-z0-9_.:-]/g, '_');
  console.warn(
    `[bridgeSession] toolName failed allowlist validation; sanitized for display. ` +
    `original=${JSON.stringify(toolName)} sanitized=${JSON.stringify(sanitized)}`,
  );
  return sanitized;
}

/** Options for ADR-9 permission control-plane wiring. All fields required together. */
export interface BridgeSessionPermOptions {
  permissionCallback: PermissionPromptCallback;
  allowAlwaysStore?: AllowAlwaysStore;
  /** Sends permission.response back to the extension over the named pipe. */
  sendPermissionResponseFn: (sessionId: string, permissionId: string, decision: 'allow' | 'deny') => void;
}

/** I9: Maximum concurrent pending permission requests. Additional requests are auto-denied. */
const MAX_PENDING_PERMISSIONS = 5;

/** I5: Maximum depth of the per-send stream queue. Exceeding this terminates the stream. */
const MAX_STREAM_QUEUE_SIZE = 1000;

/**
 * Create an AbortSignal that fires as soon as any of the supplied signals fires.
 * Equivalent to AbortSignal.any() but explicit for clarity and Node 20 compat.
 */
function raceAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    // {once: true} auto-removes after first fire; {signal: controller.signal} auto-removes
    // the remaining listeners when the controller itself aborts (prevents listener buildup).
    sig.addEventListener('abort', () => { controller.abort(sig.reason); }, {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

export class BridgeSession implements CopilotSession {
  /**
   * @param bridge   - Typed event subscriber (on/off). Accepts a real ExtensionBridge
   *                   or any fake that implements BridgeEmitter — keeping this testable.
   * @param sessionId - The bridge session ID used to correlate commands and events.
   * @param sendFn   - Injects text into the session; returns a requestId for correlation,
   *                   or `false` if the session is unreachable.
   * @param permOptions - ADR-9 permission wiring. Optional; when omitted the session
   *                      operates without permission prompting (backward compatible).
   */
  constructor(
    private readonly bridge: BridgeEmitter,
    private readonly sessionId: string,
    private readonly sendFn: (sessionId: string, text: string) => string | false,
    permOptions?: BridgeSessionPermOptions,
  ) {
    if (permOptions !== undefined) {
      this._wirePermissionHandlers(permOptions);
    }
  }

  send(text: string): AsyncIterable<string> {
    return this._generateStream(text);
  }

  // ── Permission control-plane (ADR-9) ────────────────────────────────────────

  /** Session-level AbortController — aborted when this session disconnects. */
  private readonly _sessionAbortController = new AbortController();
  /** Per-permissionId AbortControllers — aborted when permission.cancelled arrives. */
  private readonly _pendingByPermId = new Map<string, AbortController>();

  private _wirePermissionHandlers(opts: BridgeSessionPermOptions): void {
    const { permissionCallback, allowAlwaysStore, sendPermissionResponseFn } = opts;

    const onPermissionRequest = (
      sId: string,
      rId: string,
      permId: string,
      toolName: string,
      args: string,
    ): void => {
      if (sId !== this.sessionId) return;
      void this._handlePermissionRequest(
        rId, permId, toolName, args,
        permissionCallback, allowAlwaysStore, sendPermissionResponseFn,
      );
    };

    const onPermissionCancelled = (sId: string, permId: string): void => {
      if (sId !== this.sessionId) return;
      this._pendingByPermId.get(permId)?.abort();
    };

    const onDisconnected = (sId: string): void => {
      if (sId !== this.sessionId) return;
      this._sessionAbortController.abort();
      // Self-cleaning: remove all three permission listeners on disconnect.
      this.bridge.off('permission.request', onPermissionRequest as (...args: unknown[]) => void);
      this.bridge.off('permission.cancelled', onPermissionCancelled as (...args: unknown[]) => void);
      this.bridge.off('session.disconnected', onDisconnected as (...args: unknown[]) => void);
    };

    this.bridge.on('permission.request', onPermissionRequest);
    this.bridge.on('permission.cancelled', onPermissionCancelled);
    this.bridge.on('session.disconnected', onDisconnected);
  }

  private async _handlePermissionRequest(
    _requestId: string,
    permId: string,
    toolName: string,
    args: string,
    permissionCallback: PermissionPromptCallback,
    allowAlwaysStore: AllowAlwaysStore | undefined,
    sendPermissionResponseFn: (sid: string, permId: string, decision: 'allow' | 'deny') => void,
  ): Promise<void> {
    // Sanitize toolName before any use — guards against RTL overrides, null bytes,
    // control characters, or homoglyphs injected by a compromised extension.
    const safeName = sanitizeToolName(toolName);

    // Fast-path: tool in allow-always store → auto-approve without prompting.
    if (allowAlwaysStore?.has(safeName)) {
      sendPermissionResponseFn(this.sessionId, permId, 'allow');
      return;
    }

    // Per-permission AbortController for permission.cancelled support.
    const permAbortController = new AbortController();
    this._pendingByPermId.set(permId, permAbortController);

    // Combined signal: fires on session disconnect OR extension cancellation.
    const combinedSignal = raceAbortSignals([
      this._sessionAbortController.signal,
      permAbortController.signal,
    ]);

    try {
      const approved = await permissionCallback(safeName, args, combinedSignal);
      sendPermissionResponseFn(this.sessionId, permId, approved ? 'allow' : 'deny');
    } catch {
      // AbortError or any unexpected error → deny, so the extension is never left hanging.
      sendPermissionResponseFn(this.sessionId, permId, 'deny');
    } finally {
      this._pendingByPermId.delete(permId);
    }
  }

  // ── Data-plane streaming (ADR-8) ────────────────────────────────────────────

  private async *_generateStream(text: string): AsyncGenerator<string> {
    const requestId = this.sendFn(this.sessionId, text);
    if (requestId === false) {
      throw new Error(`Session ${this.sessionId} unreachable`);
    }

    // Push-to-pull bridge: listeners push items into the queue and wake the generator.
    const queue: QueueItem[] = [];
    let signal: (() => void) | null = null;
    const wake = (): void => {
      const s = signal;
      signal = null;
      s?.();
    };

    // Filter by requestId to ignore events from other concurrent sessions/sends.
    const streamListener = (
      _sId: string,
      rId: string,
      chunk: string,
      done: boolean,
    ): void => {
      if (rId !== requestId) return;
      // The final frame may carry both a non-empty chunk AND done: true — yield both.
      if (chunk.length > 0) queue.push({ kind: 'chunk', value: chunk });
      if (done) queue.push({ kind: 'done' });
      wake();
    };

    const errorListener = (
      _sId: string,
      rId: string,
      error: string,
    ): void => {
      if (rId !== requestId) return;
      queue.push({ kind: 'error', err: new Error(error) });
      wake();
    };

    this.bridge.on('stream', streamListener);
    this.bridge.on('stream.error', errorListener);

    try {
      while (true) {
        // Drain all queued items before waiting.
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.kind === 'chunk') {
            yield item.value;
          } else if (item.kind === 'done') {
            return;
          } else {
            throw item.err;
          }
        }
        // Wait for the next push. Re-check queue after assigning signal to close
        // the race window between the empty-queue check and the await.
        await new Promise<void>((r) => {
          signal = r;
          if (queue.length > 0) {
            signal = null;
            r();
          }
        });
      }
    } finally {
      // Guaranteed cleanup: runs on normal completion, error, AND early iterator abandonment.
      this.bridge.off('stream', streamListener as (...args: unknown[]) => void);
      this.bridge.off('stream.error', errorListener as (...args: unknown[]) => void);
    }
  }
}
