/**
 * AfkBridgePort — narrow dependency port for AfkModeController → bridge communication.
 *
 * Decouples the controller from the concrete ExtensionBridge so tests can
 * supply a lightweight adapter without implementing the full bridge class.
 * ExtensionBridge satisfies this interface structurally — no explicit `implements` needed.
 */

import type { BridgeSessionInfo, OutboundMessage, RegistrationAugmenter } from '../bridge/protocol.js';

export interface AfkBridgePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'afk.request' | 'back.request' | 'session.disconnected' | 'stream' | 'stream.error', listener: (...args: any[]) => void): void;
  sendToSession(sessionId: string, msg: OutboundMessage): void;
  broadcastToSessions(msg: OutboundMessage): void;
  listSessions(): BridgeSessionInfo[];
  getSessionInfo(sessionId: string): BridgeSessionInfo | undefined;
  setRegistrationAugmenter(fn: RegistrationAugmenter): void;
}
