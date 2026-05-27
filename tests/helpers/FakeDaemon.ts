/**
 * FakeDaemon — in-process stand-in for the Reach daemon pipe server.
 *
 * Message types are defined locally to decouple from production imports while
 * staying in sync with extensionBridge.ts. Audited against InboundMessage and
 * OutboundMessage in src/bridge/extensionBridge.ts (ADR-8 + ADR-9).
 *
 * Transport: pure in-memory PassThrough stream pairs — no actual named pipe
 * required, runs on any OS in CI without elevated permissions.
 *
 * Fake-timer compatible: all timing (heartbeat setInterval, pong-grace
 * setTimeout) relies on the global timer implementations that vi.useFakeTimers()
 * replaces. Advance time with vi.advanceTimersByTime() in tests.
 *
 * Usage:
 *   const daemon = new FakeDaemon();
 *   const client = new FakeExtensionClient('sess-1', 'reach-myapp');
 *   client.connect(daemon);          // in-memory handshake
 *   await client.sendHello();
 *   vi.advanceTimersByTime(30_000);  // trigger first ping cycle
 *   daemon.assertReceived({ type: 'pong' });
 */

import { PassThrough } from 'stream';
import { createInterface } from 'readline';

// ─── Protocol types ───────────────────────────────────────────────────────────
// ADR-3: UTF-8 JSON, newline-delimited, max 64 KB per line.
// ADR-7: ping/pong schema.

export type HelloMessage = {
  type: 'hello';
  sessionId: string;
  sessionName: string;
  /** ADR-10: per-run auth token. Optional so tests that don't set a required token still work. */
  authToken?: string;
};

export type PongMessage = {
  type: 'pong';
  id: string;
  sessionId: string;
};

export type StreamChunkMessage = {
  type: 'stream';
  sessionId: string;
  requestId: string;
  chunk: string;
  done: boolean;
};

export type StreamErrorMessage = {
  type: 'stream.error';
  sessionId: string;
  requestId: string;
  error: string;
};

/**
 * Forward-compat hook (ADR-8 §6): daemon-pushed session lifecycle events
 * (tool calls, permission prompts, etc.). No handler today — daemon logs and
 * ignores. Shape per ADR-8 canonical schema.
 */
export type SessionEventMessage = {
  type: 'session.event';
  sessionId: string;
  payload: unknown;
};

/** ADR-9: extension requests user approval before executing a destructive tool. */
export type PermissionRequestMessage = {
  type: 'permission.request';
  sessionId: string;
  requestId: string;
  permissionId: string;
  toolName: string;
  args: string;
  riskLevel: 'destructive';
};

/** ADR-9: extension has abandoned a pending permissionCallback. */
export type PermissionCancelledMessage = {
  type: 'permission.cancelled';
  sessionId: string;
  permissionId: string;
};

/** ADR-11: extension asks the daemon to enter machine-wide AFK mode. */
export type AfkRequestMessage = {
  type: 'afk.request';
  sessionId: string;
};

/** ADR-11: extension asks the daemon to return from AFK mode. */
export type BackRequestMessage = {
  type: 'back.request';
  sessionId: string;
};

/** All message shapes the daemon can receive from an extension. */
export type InboundMessage =
  | HelloMessage
  | PongMessage
  | StreamChunkMessage
  | StreamErrorMessage
  | SessionEventMessage
  | PermissionRequestMessage
  | PermissionCancelledMessage
  | AfkRequestMessage
  | BackRequestMessage;

export type PingMessage = {
  type: 'ping';
  id: string;
  sessionId: string;
};

export type ModeState = {
  active: boolean;
  since: string;
};

export type SessionRegisteredMessage = {
  type: 'session.registered';
  sessionId: string;
  /** ADR-11 late-joiner field: present when daemon mode state is known. */
  mode?: ModeState;
  /** ADR-11 late-joiner field: present when a Telegram topic is mapped. */
  topicId?: number;
  /** R9-6: present when registration augmentation failed; contains error class name. */
  augmenterWarning?: string;
};

export type InjectMessage = {
  type: 'inject';
  sessionId: string;
  requestId: string;
  text: string;
};

/** ADR-9: daemon delivers the user's approval decision to the extension. */
export type PermissionResponseMessage = {
  type: 'permission.response';
  sessionId: string;
  permissionId: string;
  decision: 'allow' | 'deny';
};

/** ADR-11: daemon confirms that a session's Telegram topic is ready. */
export type AfkActivatedMessage = {
  type: 'afk.activated';
  sessionId: string;
  topicId: number;
  topicUrl: string;
};

/** ADR-11: daemon confirms local-only mode resumed for a session. */
export type BackConfirmedMessage = {
  type: 'back.confirmed';
  sessionId: string;
};

/** ADR-11: daemon broadcasts machine-wide AFK mode changes. */
export type ModeChangedMessage = {
  type: 'mode.changed';
  active: boolean;
  since: string;
};

/** ADR-11: daemon mirrors Telegram text into a CLI extension. */
export type MirrorInputMessage = {
  type: 'mirror.input';
  sessionId: string;
  text: string;
  source: 'telegram';
  topicId: number;
};

/** ADR-11: designed envelope for future relay slash commands. */
export type RelayCommandMessage = {
  type: 'relay.command';
  sessionId: string;
  command: string;
  args: string[];
};

/** ADR-11/Carter: daemon sends an error frame to the extension. */
export type ErrorMessage = {
  type: 'error';
  sessionId: string;
  error: string;
  code?: string;
};

/** All message shapes the daemon can send to an extension. */
export type OutboundMessage =
  | PingMessage
  | SessionRegisteredMessage
  | InjectMessage
  | PermissionResponseMessage
  | AfkActivatedMessage
  | BackConfirmedMessage
  | ModeChangedMessage
  | MirrorInputMessage
  | RelayCommandMessage
  | ErrorMessage;

export type AnyPipeMessage = InboundMessage | OutboundMessage;

// ─── Internal connection record ───────────────────────────────────────────────

interface ConnectionRecord {
  /** The `sessionId` supplied in the `hello` message, set after registration. */
  sessionId: string | null;
  /** Stream the daemon writes outbound messages to (client reads this). */
  toClient: PassThrough;
  /** Stream the daemon reads inbound messages from (client writes this). */
  fromClient: PassThrough;
  registered: boolean;
  /** Pending pings keyed by ping id, value = setTimeout handle for grace period. */
  pendingPings: Map<string, ReturnType<typeof setTimeout>>;
}

/** Stamped inbound message with the raw sessionId it arrived on. */
export interface ReceivedRecord {
  message: InboundMessage;
  connectionIndex: number;
}

// ─── FakeDaemon ───────────────────────────────────────────────────────────────

/**
 * In-process daemon double. Manages a collection of in-memory client
 * connections, parses JSON-Lines, tracks received messages, and optionally
 * drives a heartbeat loop.
 */
export class FakeDaemon {
  /** All connections accepted so far, indexed in order of arrival. */
  private connections: ConnectionRecord[] = [];

  /** All messages received from all connections, in arrival order. */
  private _received: ReceivedRecord[] = [];

  /** Sessions that the daemon has marked unreachable. */
  private _unreachable: Set<string> = new Set();

  /** ADR-11 mode state used by amended session.registered test flows. */
  private _mode: ModeState | undefined;

  /** ADR-11 sessionId → topicId mapping used by late-joiner test flows. */
  private _topicBySession: Map<string, number> = new Map();

  /** Handle for the heartbeat interval, if running. */
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  /** Monotonically increasing ping counter for generating unique IDs. */
  private pingCounter = 0;

  /**
   * If set, `hello` messages must carry a matching `authToken`.
   * Connections with a wrong/missing token are closed without response (no oracle).
   * Default: null (no auth check — backward-compatible with existing tests).
   */
  private _requiredToken: string | null = null;

  // ── Connection factory ──────────────────────────────────────────────────────

  /**
   * Configure a required auth token (ADR-10 test support).
   * When set, `hello` messages that carry a wrong or missing `authToken` are
   * silently rejected: the `toClient` stream is closed, no `session.registered`
   * is sent, and the hello is NOT recorded in `_received`.
   *
   * Pass `null` to disable the check (the default — backward-compatible).
   */
  setRequiredToken(token: string | null): void {
    this._requiredToken = token;
  }

  /**
   * Creates a new in-memory connection pair and registers it with the daemon.
   * Returns the *client-side* stream handles so a FakeExtensionClient can attach.
   *
   * Call order: FakeExtensionClient.connect() calls this internally.
   */
  accept(): { toServer: PassThrough; fromServer: PassThrough; connectionIndex: number } {
    const toClient = new PassThrough();   // daemon writes here → client reads
    const fromClient = new PassThrough(); // client writes here → daemon reads

    const index = this.connections.length;
    const record: ConnectionRecord = {
      sessionId: null,
      toClient,
      fromClient,
      registered: false,
      pendingPings: new Map(),
    };
    this.connections.push(record);

    // Wire the readline parser for inbound messages.
    const rl = createInterface({ input: fromClient, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let msg: InboundMessage;
      try {
        msg = JSON.parse(line) as InboundMessage;
      } catch {
        return; // malformed line — ignore
      }
      this._handleInbound(msg, record, index);
    });

    // Pipe-teardown detection: when the client closes their write side, mark
    // the session unreachable immediately (ADR-7 fast path).
    fromClient.on('end', () => {
      if (record.sessionId) {
        this._unreachable.add(record.sessionId);
        record.registered = false;
        // Cancel any pending ping grace timers.
        for (const handle of record.pendingPings.values()) clearTimeout(handle);
        record.pendingPings.clear();
      }
    });

    return {
      toServer: fromClient,   // client writes TO server on this stream
      fromServer: toClient,   // client reads FROM server on this stream
      connectionIndex: index,
    };
  }

  // ── Inbound message handling ─────────────────────────────────────────────────

  private _handleInbound(msg: InboundMessage, record: ConnectionRecord, index: number): void {
    // ADR-10: validate auth token on hello BEFORE recording the message.
    // Mimic real daemon: close silently, no error frame, do not record.
    if (
      msg.type === 'hello' &&
      this._requiredToken !== null &&
      msg.authToken !== this._requiredToken
    ) {
      record.toClient.end();
      record.registered = false;
      return;
    }

    this._received.push({ message: msg, connectionIndex: index });

    switch (msg.type) {
      case 'hello': {
        record.sessionId = msg.sessionId;
        record.registered = true;
        this._unreachable.delete(msg.sessionId);
        this._writeTo(record, {
          type: 'session.registered',
          sessionId: msg.sessionId,
          ...(this._mode !== undefined && { mode: this._mode }),
          ...(this._topicBySession.has(msg.sessionId) && { topicId: this._topicBySession.get(msg.sessionId) }),
        });
        break;
      }

      case 'pong': {
        // Cancel the grace-period timer for this ping, session is alive.
        const handle = record.pendingPings.get(msg.id);
        if (handle !== undefined) {
          clearTimeout(handle);
          record.pendingPings.delete(msg.id);
        }
        break;
      }

      // stream / stream.error are just recorded; callers assert on them.
      default:
        break;
    }
  }

  // ── Outbound helpers ─────────────────────────────────────────────────────────

  private _writeTo(record: ConnectionRecord, msg: OutboundMessage): void {
    const line = JSON.stringify(msg) + '\n';
    record.toClient.write(line);
  }

  /**
   * Sends an arbitrary outbound message to the connection with the given
   * sessionId. Throws if no registered connection is found.
   */
  sendTo(sessionId: string, msg: OutboundMessage): void {
    const record = this._findBySessionId(sessionId);
    this._writeTo(record, msg);
  }

  /** Configures the ADR-11 mode/topic fields included in future session.registered acks. */
  setMode(active: boolean, since = '2026-05-24T23:19:14-07:00'): void {
    this._mode = { active, since };
  }

  /** Configures the ADR-11 late-joiner topic mapping for a session. */
  setTopicForSession(sessionId: string, topicId: number): void {
    this._topicBySession.set(sessionId, topicId);
  }

  /** Sends ADR-11 afk.activated and records the mapping for future session.registered acks. */
  sendAfkActivated(sessionId: string, topicId: number, topicUrl = `https://t.me/c/test/${topicId}`): void {
    this._topicBySession.set(sessionId, topicId);
    this.sendTo(sessionId, { type: 'afk.activated', sessionId, topicId, topicUrl });
  }

  /** Sends ADR-11 back.confirmed. */
  sendBackConfirmed(sessionId: string): void {
    this.sendTo(sessionId, { type: 'back.confirmed', sessionId });
  }

  /** Broadcasts ADR-11 mode.changed to all registered clients. */
  sendModeChanged(active: boolean, since = '2026-05-24T23:19:14-07:00'): void {
    this._mode = { active, since };
    for (const record of this.connections) {
      if (!record.registered || !record.sessionId) continue;
      this._writeTo(record, { type: 'mode.changed', active, since });
    }
  }

  /** Sends ADR-11 mirror.input to a registered session. */
  sendMirrorInput(sessionId: string, text: string, topicId: number): void {
    this.sendTo(sessionId, { type: 'mirror.input', sessionId, text, source: 'telegram', topicId });
  }

  /** Sends an error frame to a registered session. */
  sendError(sessionId: string, error: string, code?: string): void {
    this.sendTo(sessionId, { type: 'error', sessionId, error, ...(code !== undefined && { code }) });
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────────

  /**
   * Starts the ADR-7 heartbeat loop: every 30 s, send a `ping` to every
   * registered connection. If a `pong` does not arrive within 5 s, a 15 s
   * grace-period timer starts; if that also expires the session is marked
   * unreachable.
   *
   * All timers are standard setTimeout/setInterval so vi.useFakeTimers() works.
   */
  startHeartbeat(): void {
    if (this.heartbeatHandle) return;
    this.heartbeatHandle = setInterval(() => {
      this._sendHeartbeat();
    }, 30_000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  private _sendHeartbeat(): void {
    for (const record of this.connections) {
      if (!record.registered || !record.sessionId) continue;
      const pingId = `ping-${++this.pingCounter}`;
      const ping: PingMessage = { type: 'ping', id: pingId, sessionId: record.sessionId };

      // ADR-7: pong must arrive within 5 s; then 15 s grace before unreachable.
      // IMPORTANT: register the deadline handle in pendingPings BEFORE calling
      // _writeTo. The in-memory PassThrough transport is synchronous — the pong
      // can arrive (and try to clearTimeout) within the same call stack as the
      // push. If we set pendingPings after _writeTo, the pong handler finds no
      // entry and the orphaned timer fires, incorrectly marking the session
      // unreachable.
      const pongDeadline = setTimeout(() => {
        if (!record.pendingPings.has(pingId)) return; // already resolved
        record.pendingPings.delete(pingId);
        if (!record.sessionId) return;
        const sid = record.sessionId;
        // Grace period: 15 s before marking unreachable.
        const graceHandle = setTimeout(() => {
          this._unreachable.add(sid);
          record.registered = false;
        }, 15_000);
        // Stash grace handle so tests can introspect or advance past it.
        record.pendingPings.set(`${pingId}-grace`, graceHandle);
      }, 5_000);

      record.pendingPings.set(pingId, pongDeadline);
      this._writeTo(record, ping);
    }
  }

  // ── Disconnect helpers ───────────────────────────────────────────────────────

  /**
   * Simulates an abrupt server-side pipe teardown (e.g. daemon crash or
   * forceful session close). Ends the `fromServer` stream that the client is
   * reading from, which fires an 'end' event on the client side.
   */
  disconnectSession(sessionId: string): void {
    const record = this._findBySessionId(sessionId);
    record.toClient.end();
    record.registered = false;
    for (const handle of record.pendingPings.values()) clearTimeout(handle);
    record.pendingPings.clear();
  }

  // ── Query / assertion helpers ────────────────────────────────────────────────

  /** All inbound messages received so far, across all connections. */
  get received(): ReceivedRecord[] {
    return this._received;
  }

  /**
   * All inbound messages received from the session with the given sessionId.
   * Returns an empty array if none.
   */
  messagesFrom(sessionId: string): InboundMessage[] {
    return this._received
      .filter((r) => r.message.sessionId === sessionId)
      .map((r) => r.message);
  }

  /** Last inbound message received from the given sessionId, or undefined. */
  lastMessageFrom(sessionId: string): InboundMessage | undefined {
    const msgs = this.messagesFrom(sessionId);
    return msgs[msgs.length - 1];
  }

  /** All inbound messages of a specific type. */
  messagesOfType<T extends InboundMessage['type']>(
    type: T,
  ): Extract<InboundMessage, { type: T }>[] {
    return this._received
      .map((r) => r.message)
      .filter((m): m is Extract<InboundMessage, { type: T }> => m.type === type);
  }

  /** Returns true if the session is currently marked unreachable. */
  isUnreachable(sessionId: string): boolean {
    return this._unreachable.has(sessionId);
  }

  /** Returns true if the session has an active registered connection. */
  isRegistered(sessionId: string): boolean {
    return this.connections.some((c) => c.sessionId === sessionId && c.registered);
  }

  /** Returns the first received afk.request for a session or throws. */
  expectAfkRequest(sessionId: string): AfkRequestMessage {
    const msg = this.messagesOfType('afk.request').find((m) => m.sessionId === sessionId);
    if (!msg) throw new Error(`Expected afk.request from ${sessionId}`);
    return msg;
  }

  /** Returns the first received back.request for a session or throws. */
  expectBackRequest(sessionId: string): BackRequestMessage {
    const msg = this.messagesOfType('back.request').find((m) => m.sessionId === sessionId);
    if (!msg) throw new Error(`Expected back.request from ${sessionId}`);
    return msg;
  }

  /** Number of connections accepted (registered or not). */
  get connectionCount(): number {
    return this.connections.length;
  }

  // ── Reset ────────────────────────────────────────────────────────────────────

  /** Clears all state. Call between tests when reusing the same instance. */
  reset(): void {
    this.stopHeartbeat();
    for (const record of this.connections) {
      for (const handle of record.pendingPings.values()) clearTimeout(handle);
      record.toClient.destroy();
      record.fromClient.destroy();
    }
    this.connections = [];
    this._received = [];
    this._unreachable.clear();
    this._mode = undefined;
    this._topicBySession.clear();
    this.pingCounter = 0;
    this._requiredToken = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _findBySessionId(sessionId: string): ConnectionRecord {
    const record = this.connections.find((c) => c.sessionId === sessionId);
    if (!record) {
      throw new Error(`FakeDaemon: no connection registered for sessionId="${sessionId}"`);
    }
    return record;
  }
}
