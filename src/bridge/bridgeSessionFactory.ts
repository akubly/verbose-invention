/**
 * bridgeSessionFactory.ts — CopilotSessionFactory backed by the extension bridge.
 *
 * Bridge sessions are created externally: the CLI extension attaches to the daemon
 * by connecting to the named pipe and sending a `hello` message. This factory's job
 * is to look up those externally-registered sessions and wrap them in BridgeSession
 * adapters so relay.ts can consume them via the standard CopilotSession contract.
 *
 * Permission prompting: bridge sessions do not currently support tool-permission
 * prompting through the wire protocol. The parameter is accepted for interface
 * compatibility but ignored. TODO ADR-9? — permission prompting over the bridge
 * is a future protocol extension; the SDK path handles this via onPermissionRequest
 * and there is no equivalent hook in the bridge wire protocol yet.
 */

import type {
  CopilotSession,
  CopilotSessionFactory,
  PermissionPromptCallback,
} from '../copilot/factory.js';
import { BridgeSession } from './bridgeSession.js';
import type { ExtensionBridge } from './extensionBridge.js';

export class BridgeSessionFactory implements CopilotSessionFactory {
  constructor(private readonly bridge: ExtensionBridge) {}

  /**
   * Returns a BridgeSession if the extension has a session registered under
   * `sessionName`, or `null` if the extension hasn't attached yet.
   * The relay will fall back to `create()` (or the SDK factory) on `null`.
   */
  async resume(
    sessionName: string,
    _model?: string,
    // TODO ADR-9? Permission prompting over the bridge is a future protocol extension.
    // Bridge sessions don't support tool-permission prompting through the wire protocol.
    // The SDK path handles this via onPermissionRequest; no equivalent bridge hook exists yet.
    _permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession | null> {
    void _model;
    void _permissionCallback;
    const conn = this.bridge.getSessionByName(sessionName);
    if (!conn) return null;
    return new BridgeSession(
      this.bridge,
      conn.sessionId,
      this.bridge.sendCommand.bind(this.bridge),
    );
  }

  /**
   * Same lookup logic as `resume()`. If the session isn't registered on the bridge,
   * throws — the bridge does not create sessions; the extension does.
   */
  async create(
    sessionName: string,
    _model?: string,
    _permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession> {
    void _model;
    void _permissionCallback;
    const conn = this.bridge.getSessionByName(sessionName);
    if (!conn) {
      throw new Error(
        `Bridge session "${sessionName}" is not registered — ` +
          `sessions are created externally when the extension attaches to the daemon pipe`,
      );
    }
    return new BridgeSession(
      this.bridge,
      conn.sessionId,
      this.bridge.sendCommand.bind(this.bridge),
    );
  }

  /**
   * No-op: ADR-6 — the extension reconnects on its own exponential backoff schedule.
   * There is no factory-level restart concept on the bridge side.
   */
  resetForRestart(): void {
    // intentional no-op per ADR-6
  }
}
