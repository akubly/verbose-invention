/**
 * AfkBridgePort — narrow dependency port for AfkModeController → bridge communication.
 *
 * Decouples the controller from the concrete ExtensionBridge so tests can
 * supply a lightweight adapter without implementing the full bridge class.
 * ExtensionBridge satisfies this interface structurally — no explicit `implements` needed.
 */

import type { BridgeSessionInfo, OutboundMessage, RegistrationAugmenter } from '../bridge/protocol.js';

export interface AfkBridgeEvents {
  'afk.request': [sessionId: string, lastAssistantExcerpt?: string];
  'back.request': [sessionId: string];
  'session.disconnected': [sessionId: string];
  stream: [sessionId: string, requestId: string, chunk: string, done: boolean];
  'stream.error': [sessionId: string, requestId: string, error: string];
}

export interface AfkBridgePort {
  on<K extends keyof AfkBridgeEvents>(event: K, listener: (...args: AfkBridgeEvents[K]) => void): void;
  sendToSession(sessionId: string, msg: OutboundMessage): void;
  broadcastToSessions(msg: OutboundMessage): void;
  listSessions(): BridgeSessionInfo[];
  getSessionInfo(sessionId: string): BridgeSessionInfo | undefined;
  setRegistrationAugmenter(fn: RegistrationAugmenter): void;
}
