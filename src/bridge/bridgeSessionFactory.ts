/**
 * bridgeSessionFactory.ts — CopilotSessionFactory backed by the extension bridge.
 *
 * Bridge sessions are created externally: the CLI extension attaches to the daemon
 * by connecting to the named pipe and sending a `hello` message. This factory's job
 * is to look up those externally-registered sessions and wrap them in BridgeSession
 * adapters so relay.ts can consume them via the standard CopilotSession contract.
 *
 * ADR-9: When a permissionCallback is supplied by the relay, it is forwarded to the
 * BridgeSession which wires the permission control-plane over the pipe. The optional
 * AllowAlwaysStore enables per-session auto-approve for previously consented tools.
 */

import type {
  CopilotSession,
  CopilotSessionFactory,
  PermissionPromptCallback,
} from '../copilot/factory.js';
import { BridgeSession } from './bridgeSession.js';
import type { ExtensionBridge } from './extensionBridge.js';
import { InMemoryAllowAlwaysStore } from './allowAlwaysStore.js';

export class BridgeSessionFactory implements CopilotSessionFactory {
  /**
   * @param bridge - The named-pipe server.
   */
  constructor(private readonly bridge: ExtensionBridge) {}

  /**
   * Returns a BridgeSession if the extension has a session registered under
   * `sessionName`, or `null` if the extension hasn't attached yet.
   * The relay will fall back to `create()` (or the SDK factory) on `null`.
   */
  async resume(
    sessionName: string,
    _model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession | null> {
    // _model unused: bridge sessions are model-agnostic — the extension selects the model at CLI startup.
    const conn = this.bridge.getSessionByName(sessionName);
    if (!conn) return null;
    return this._makeSession(conn.sessionId, permissionCallback);
  }

  /**
   * Same lookup logic as `resume()`. If the session isn't registered on the bridge,
   * throws — the bridge does not create sessions; the extension does.
   */
  async create(
    sessionName: string,
    _model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession> {
    // _model unused: bridge sessions are model-agnostic — the extension selects the model at CLI startup.
    const conn = this.bridge.getSessionByName(sessionName);
    if (!conn) {
      throw new Error(
        `Bridge session "${sessionName}" is not registered — ` +
          `sessions are created externally when the extension attaches to the daemon pipe`,
      );
    }
    return this._makeSession(conn.sessionId, permissionCallback);
  }

  /**
   * No-op: ADR-6 — the extension reconnects on its own exponential backoff schedule.
   * There is no factory-level restart concept on the bridge side.
   */
  resetForRestart(): void {
    // intentional no-op per ADR-6
  }

  private _makeSession(sessionId: string, permissionCallback?: PermissionPromptCallback): BridgeSession {
    const permOptions = permissionCallback !== undefined
      ? {
          permissionCallback,
          // Fresh store per session — enforces ADR-9 Q2 per-session isolation contract.
          allowAlwaysStore: new InMemoryAllowAlwaysStore(),
          sendPermissionResponseFn: (sid: string, permId: string, decision: 'allow' | 'deny'): void => {
            this.bridge.sendPermissionResponse(sid, permId, decision);
          },
        }
      : undefined;

    return new BridgeSession(
      this.bridge,
      sessionId,
      this.bridge.sendCommand.bind(this.bridge),
      permOptions,
    );
  }
}
