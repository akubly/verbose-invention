/**
 * extensionBridge.ts — Named-pipe server (daemon side).
 *
 * Listens on a randomised pipe path (ADR-10) supplied via PipeAuthConfig.
 * Each CLI extension instance connects, sends a `hello` message with an
 * authToken, and is tracked in a Map<sessionId, ExtensionConnection>.
 *
 * Protocol: UTF-8 JSON-Lines (one JSON object per newline-terminated line).
 *           Max 64 KB per line (ADR-3).
 *           Canonical message schema per ADR-8.
 *
 * Heartbeat: daemon sends `ping` every 30 s (ADR-7). Extension must reply
 *            `pong` within 5 s; if missed, a 15 s grace period begins.
 *            After grace expires without pong the session is marked
 *            unreachable and evicted. Normal pipe teardown is detected
 *            immediately via the `close` event (fast path, <1 s).
 *
 * ADR compliance: ADR-3 (single pipe), ADR-4 (crash = unreachable),
 *                 ADR-5 (user-level daemon), ADR-7 (ping/pong + teardown),
 *                 ADR-8 (canonical wire protocol: inject/stream/requestId).
 */

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { PipeAuthConfig } from './pipeAuth.js';
import { cleanupPipeAuth } from './pipeAuth.js';

// ── Protocol types (re-exported for backwards compatibility) ──────────────────
export type * from './protocol.js';
import type {
  RegisterMessage,
  PongMessage,
  SessionEventMessage,
  StreamMessage,
  StreamErrorMessage,
  PermissionRequestMessage,
  PermissionCancelledMessage,
  AfkRequestMessage,
  BackRequestMessage,
  BridgeSessionInfo,
  RegistrationAugmenter,
  RegistrationExtras,
  OutboundMessage,
} from './protocol.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
/** ADR-7: pong expected within this many ms after a ping is sent. */
const PONG_WINDOW_MS = 5_000;
/** ADR-7: grace period after missed pong before marking session unreachable. */
const GRACE_PERIOD_MS = 15_000;
/** ADR-3: max bytes per JSON-Lines frame (64 KB). */
const MAX_LINE_BYTES = 64 * 1024;

// ── Connection state ─────────────────────────────────────────────────────────

/** Status of an extension session. */
export type ConnectionStatus = 'registered' | 'unreachable';

/** Public handle for a registered extension connection. */
export interface ExtensionConnection extends BridgeSessionInfo {
  readonly status: ConnectionStatus;
  /** Send a typed outbound message to this extension. */
  send(msg: OutboundMessage): void;
}

/** Internal implementation — includes mutable status and heartbeat bookkeeping. */
interface InternalConnection extends ExtensionConnection {
  status: ConnectionStatus;
  /** Human-readable session label supplied in the `hello` message (SESSION_NAME env var). */
  readonly sessionName: string;
  /** Working directory supplied by the extension, or daemon cwd for legacy extensions. */
  readonly cwd: string;
  readonly socket: net.Socket;
  /** ID of the ping we're waiting on, or undefined if no outstanding ping. */
  pendingPingId: string | undefined;
  pongTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  graceTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
}

// ── BridgeEmitter — typed event emitter (composition) ───────────────────────

/**
 * Typed event subscription handle for ExtensionBridge.
 *
 * Events:
 * - `session.registered`   — extension connected and sent hello
 * - `session.disconnected` — pipe closed or heartbeat timed out (session evicted)
 * - `session.event`        — CLI event forwarded by the extension (reserved, future use)
 * - `stream`               — one streaming chunk from a CLI response
 * - `stream.error`         — terminal error for a CLI response
 * - `permission.request`   — destructive tool needs user approval (ADR-9)
 * - `permission.cancelled` — extension abandoned a pending permission (ADR-9)
 * - `afk.request`          — CLI user requested machine-wide AFK mode (ADR-11)
 * - `back.request`         — CLI user requested machine-wide back-at-desk mode (ADR-11)
 */
export interface BridgeEmitter {
  on(event: 'session.registered', listener: (sessionId: string) => void): this;
  on(event: 'session.disconnected', listener: (sessionId: string) => void): this;
  on(event: 'session.event', listener: (sessionId: string, payload: unknown) => void): this;
  on(
    event: 'stream',
    listener: (sessionId: string, requestId: string, chunk: string, done: boolean) => void,
  ): this;
  on(
    event: 'stream.error',
    listener: (sessionId: string, requestId: string, error: string) => void,
  ): this;
  on(
    event: 'permission.request',
    listener: (
      sessionId: string,
      requestId: string,
      permissionId: string,
      toolName: string,
      args: string,
    ) => void,
  ): this;
  on(
    event: 'permission.cancelled',
    listener: (sessionId: string, permissionId: string) => void,
  ): this;
  on(event: 'afk.request', listener: (sessionId: string) => void): this;
  on(event: 'back.request', listener: (sessionId: string) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}

// ── ExtensionBridge ───────────────────────────────────────────────────────────

/**
 * Named-pipe server that multiplexes connections from Copilot CLI extension
 * processes. Implements BridgeEmitter for typed event subscriptions.
 */
export class ExtensionBridge implements BridgeEmitter {
  private readonly _emitter = new EventEmitter();
  private server: net.Server | null = null;
  /** Registered sessions, keyed by sessionId. */
  private readonly sessions = new Map<string, InternalConnection>();
  private registrationAugmenter: RegistrationAugmenter | undefined;
  /** Sockets that have connected but not yet sent `register`. */
  private readonly pendingSockets = new Set<net.Socket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly _authConfig: PipeAuthConfig) {}

  // ── BridgeEmitter implementation ─────────────────────────────────────────

  on(event: 'session.registered', listener: (sessionId: string) => void): this;
  on(event: 'session.disconnected', listener: (sessionId: string) => void): this;
  on(event: 'session.event', listener: (sessionId: string, payload: unknown) => void): this;
  on(
    event: 'stream',
    listener: (sessionId: string, requestId: string, chunk: string, done: boolean) => void,
  ): this;
  on(
    event: 'stream.error',
    listener: (sessionId: string, requestId: string, error: string) => void,
  ): this;
  on(
    event: 'permission.request',
    listener: (
      sessionId: string,
      requestId: string,
      permissionId: string,
      toolName: string,
      args: string,
    ) => void,
  ): this;
  on(
    event: 'permission.cancelled',
    listener: (sessionId: string, permissionId: string) => void,
  ): this;
  on(event: 'afk.request', listener: (sessionId: string) => void): this;
  on(event: 'back.request', listener: (sessionId: string) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this._emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this._emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start the named-pipe server.
   * Resolves when the server is listening and ready to accept connections.
   * No-op if already started.
   */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.server !== null) {
        resolve();
        return;
      }

      const server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      server.once('error', (err) => {
        reject(err);
      });

      server.listen(this._authConfig.pipePath, () => {
        this.server = server;
        this.startHeartbeat();
        console.log(`[bridge] Listening on ${this._authConfig.pipePath}`);
        resolve();
      });
    });
  }

  /**
   * Gracefully stop the server, cancel all heartbeat timers, and destroy
   * every open socket. Resolves when the server is fully closed AND the auth
   * file has been removed, so callers (e.g. main.ts shutdown) are guaranteed
   * that bridge-auth.json is gone before process.exit() runs (T7 — ADR-10).
   */
  stop(): Promise<void> {
    this.stopHeartbeat();

    for (const conn of this.sessions.values()) {
      this.clearPingState(conn);
      conn.socket.destroy();
    }
    for (const socket of this.pendingSockets) {
      socket.destroy();
    }
    this.sessions.clear();
    this.pendingSockets.clear();

    // N2/T7: await cleanupPipeAuth() inside the returned Promise so stop() only
    // resolves after the auth file is gone.  The original `void cleanupPipeAuth()`
    // was fire-and-forget and could race with process.exit(0) in main.ts shutdown,
    // leaving bridge-auth.json on disk intermittently.
    const cleanup = (): Promise<void> => cleanupPipeAuth();

    return new Promise<void>((resolve) => {
      if (this.server === null) {
        void cleanup().then(resolve);
        return;
      }
      this.server.close(() => {
        this.server = null;
        void cleanup().then(resolve);
      });
    });
  }

  /**
   * Returns the public handle for a registered session, or `undefined`
   * if the session is not currently connected.
   */
  getSession(sessionId: string): ExtensionConnection | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionInfo(sessionId: string): BridgeSessionInfo | undefined {
    const conn = this.sessions.get(sessionId);
    return conn && conn.status === 'registered'
      ? { sessionId: conn.sessionId, sessionName: conn.sessionName, cwd: conn.cwd }
      : undefined;
  }

  listSessions(): BridgeSessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((conn) => conn.status === 'registered')
      .map((conn) => ({ sessionId: conn.sessionId, sessionName: conn.sessionName, cwd: conn.cwd }));
  }

  setRegistrationAugmenter(augmenter: RegistrationAugmenter): void {
    if (this.registrationAugmenter !== undefined) {
      throw new Error('registration augmenter already set');
    }
    this.registrationAugmenter = augmenter;
  }

  sendToSession(sessionId: string, msg: OutboundMessage): boolean {
    const conn = this.sessions.get(sessionId);
    if (conn === undefined || conn.status !== 'registered') return false;
    conn.send(msg);
    return true;
  }

  broadcastToSessions(msg: OutboundMessage): void {
    for (const conn of this.sessions.values()) {
      if (conn.status === 'registered') conn.send(msg);
    }
  }

  /**
   * Look up a registered session by its human-readable name (the `sessionName`
   * field from the extension's `hello` message — typically the SESSION_NAME env var).
   * Returns `undefined` if no registered session has that name, or if the matching
   * session has become unreachable.
   */
  getSessionByName(sessionName: string): ExtensionConnection | undefined {
    for (const conn of this.sessions.values()) {
      if (conn.sessionName === sessionName && conn.status === 'registered') {
        return conn;
      }
    }
    return undefined;
  }

  /**
   * Inject a text command into an extension identified by `sessionId`.
   * Generates and returns a `requestId` for response correlation.
   * Returns `false` if the session is not registered or is unreachable.
   */
  sendCommand(sessionId: string, text: string): string | false {
    const conn = this.sessions.get(sessionId);
    if (conn === undefined || conn.status !== 'registered') return false;
    const requestId = randomUUID();
    conn.send({ type: 'inject', sessionId, requestId, text });
    return requestId;
  }

  /**
   * Send a `permission.response` to the extension for the given session.
   * No-op if the session is not registered or unreachable — the extension
   * will detect the pipe drop via its own close handler.
   */
  sendPermissionResponse(sessionId: string, permissionId: string, decision: 'allow' | 'deny'): void {
    const conn = this.sessions.get(sessionId);
    if (conn === undefined || conn.status !== 'registered') return;
    conn.send({ type: 'permission.response', sessionId, permissionId, decision });
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    // Minor: cap pre-hello (pending) sockets to prevent slow-loris resource exhaustion.
    if (this.pendingSockets.size >= 10) {
      console.warn('[bridge] Pending socket limit (10) reached — rejecting new connection');
      socket.destroy();
      return;
    }

    this.pendingSockets.add(socket);

    // Minor: 10s auth timeout — if hello isn't received by then, close the socket.
    const authTimeout = setTimeout(() => {
      if (this.pendingSockets.has(socket)) {
        console.warn('[bridge] Auth timeout (10 s) — closing pre-hello socket');
        this.pendingSockets.delete(socket);
        socket.destroy();
      }
    }, 10_000);
    socket.once('close', () => { clearTimeout(authTimeout); });

    let lineBuffer = '';

    socket.setEncoding('utf-8');

    socket.on('data', (chunk: string) => {
      lineBuffer += chunk;

      // DoS guard: drop connections that send frames larger than 64 KB.
      if (lineBuffer.length > MAX_LINE_BYTES) {
        console.warn('[bridge] Inbound buffer exceeded 64 KB — closing connection');
        socket.destroy();
        return;
      }

      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          this.handleLine(socket, line);
        }
      }
    });

    socket.on('close', () => {
      this.pendingSockets.delete(socket);

      for (const [sessionId, conn] of this.sessions) {
        if (conn.socket === socket) {
          this.clearPingState(conn);
          this.sessions.delete(sessionId);
          console.log(`[bridge] Session disconnected (pipe close): ${sessionId}`);
          this._emitter.emit('session.disconnected', sessionId);
          break;
        }
      }
    });

    socket.on('error', (err) => {
      // 'close' fires after 'error'; cleanup is handled in the close handler.
      console.warn('[bridge] Socket error:', err.message);
    });
  }

  // ── Message dispatch ────────────────────────────────────────────────────────

  private handleLine(socket: net.Socket, line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn('[bridge] Non-JSON line received — ignoring');
      return;
    }

    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      console.warn('[bridge] Malformed message (missing type field) — ignoring');
      return;
    }

    const type = (msg as Record<string, unknown>)['type'];
    const conn = this.findConnectionBySocket(socket);

    switch (type) {
      case 'hello':
        void this.handleHello(socket, msg as RegisterMessage);
        break;
      case 'pong':
        if (conn !== undefined) this.handlePong(conn, msg as PongMessage);
        break;
      case 'session.event':
        if (conn !== undefined) {
          this._emitter.emit('session.event', conn.sessionId, (msg as SessionEventMessage).payload);
        }
        break;
      case 'stream': {
        if (conn !== undefined) {
          const sm = msg as StreamMessage;
          this._emitter.emit('stream', conn.sessionId, sm.requestId, sm.chunk, sm.done);
        }
        break;
      }
      case 'stream.error': {
        if (conn !== undefined) {
          const se = msg as StreamErrorMessage;
          this._emitter.emit('stream.error', conn.sessionId, se.requestId, se.error);
        }
        break;
      }
      case 'permission.request': {
        if (conn !== undefined) {
          const pr = msg as PermissionRequestMessage;
          if (
            typeof pr.permissionId === 'string' && pr.permissionId.length > 0 &&
            typeof pr.toolName === 'string' && pr.toolName.length > 0 &&
            pr.riskLevel === 'destructive'
          ) {
            this._emitter.emit(
              'permission.request',
              conn.sessionId,
              pr.requestId,
              pr.permissionId,
              pr.toolName,
              pr.args ?? '',
            );
          } else {
            console.warn('[bridge] permission.request: invalid fields — dropping');
          }
        }
        break;
      }
      case 'permission.cancelled': {
        if (conn !== undefined) {
          const pc = msg as PermissionCancelledMessage;
          if (typeof pc.permissionId === 'string' && pc.permissionId.length > 0) {
            this._emitter.emit('permission.cancelled', conn.sessionId, pc.permissionId);
          } else {
            console.warn('[bridge] permission.cancelled: missing permissionId — dropping');
          }
        }
        break;
      }
      case 'afk.request': {
        if (conn !== undefined) {
          const ar = msg as AfkRequestMessage;
          if (ar.sessionId === conn.sessionId) {
            this._emitter.emit('afk.request', conn.sessionId);
          } else {
            console.warn('[bridge] afk.request: sessionId mismatch — dropping');
          }
        }
        break;
      }
      case 'back.request': {
        if (conn !== undefined) {
          const br = msg as BackRequestMessage;
          if (br.sessionId === conn.sessionId) {
            this._emitter.emit('back.request', conn.sessionId);
          } else {
            console.warn('[bridge] back.request: sessionId mismatch — dropping');
          }
        }
        break;
      }
      default:
        console.warn(`[bridge] Unknown message type "${String(type)}" — ignoring`);
    }
  }

  private async handleHello(socket: net.Socket, msg: RegisterMessage): Promise<void> {
    const { sessionId } = msg;

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      console.warn('[bridge] register message missing sessionId — closing connection');
      socket.destroy();
      return;
    }

    // ADR-10 Option A: validate auth token before any session interaction.
    // Use timingSafeEqual to defend against timing side-channels.
    // Close without sending an error frame to avoid acting as an oracle.
    const provided = typeof msg.authToken === 'string'
      ? Buffer.from(msg.authToken, 'utf8')
      : Buffer.alloc(0);
    const expected = Buffer.from(this._authConfig.token, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      console.warn('[bridge] Auth token mismatch — closing unauthenticated connection');
      socket.destroy();
      return;
    }

    // I6: reject duplicate sessionName claimed by a different sessionId.
    // Allows the same sessionId to reconnect (ADR-6 hello-resend rule).
    const existingByName = this.getSessionByName(msg.sessionName);
    if (existingByName !== undefined && existingByName.sessionId !== sessionId) {
      console.warn(
        `[bridge] Rejected hello: sessionName "${msg.sessionName}" already claimed by ` +
        `${existingByName.sessionId} — closing duplicate`,
      );
      socket.destroy();
      return;
    }

    // Evict any stale connection for the same sessionId (extension reconnected
    // after daemon restart per ADR-6 backoff policy; re-sends hello on reconnect).
    const stale = this.sessions.get(sessionId);
    if (stale !== undefined && stale.socket !== socket) {
      console.log(`[bridge] Replacing stale connection for session ${sessionId}`);
      this.clearPingState(stale);
      stale.socket.destroy();
    }

    // cwd is required since ADR-11; guard against pre-ADR-11 extensions that omit the field.
    const helloCwd = typeof msg.cwd === 'string' && msg.cwd.length > 0 ? msg.cwd : undefined;
    if (helloCwd === undefined) {
      console.warn('[bridge] extension hello missing cwd — falling back; legacy client?');
    }

    const conn: InternalConnection = {
      sessionId,
      sessionName: msg.sessionName,
      cwd: helloCwd ?? process.cwd(),
      socket,
      status: 'registered',
      pendingPingId: undefined,
      pongTimeoutHandle: undefined,
      graceTimeoutHandle: undefined,
      send: (outMsg: OutboundMessage) => {
        const frame = JSON.stringify(outMsg) + '\n';
        socket.write(frame, 'utf-8', (err?: Error | null) => {
          if (err) {
            console.warn(`[bridge] Write error for session ${sessionId}:`, err.message);
          }
        });
      },
    };

    this.pendingSockets.delete(socket);
    this.sessions.set(sessionId, conn);

    let registrationExtras: RegistrationExtras = {};
    if (this.registrationAugmenter !== undefined) {
      try {
        const extras = await this.registrationAugmenter({
          sessionId: conn.sessionId,
          sessionName: conn.sessionName,
          cwd: conn.cwd,
        });
        registrationExtras = {
          ...(extras.mode !== undefined && { mode: extras.mode }),
          ...(typeof extras.topicId === 'number' && { topicId: extras.topicId }),
        };
      } catch (err) {
        const warning = err instanceof Error ? err.constructor.name : 'UnknownError';
        console.warn('[bridge] Registration augmenter failed:', err instanceof Error ? err.message : String(err));
        registrationExtras = { augmenterWarning: warning };
      }
    }

    if (this.sessions.get(sessionId) !== conn || socket.destroyed) {
      return;
    }

    conn.send({ type: 'session.registered', sessionId, ...registrationExtras });
    console.log(`[bridge] Session registered: ${sessionId}`);
    this._emitter.emit('session.registered', sessionId);
  }

  private handlePong(conn: InternalConnection, msg: PongMessage): void {
    if (conn.pendingPingId !== undefined && conn.pendingPingId === msg.id) {
      this.clearPingState(conn);
      if (conn.status === 'unreachable') {
        // unreachable: the session is deleted from this.sessions before the grace period
        // expires (sendPing → graceTimeout → sessions.delete → socket.destroy), so
        // findConnectionBySocket returns undefined and handlePong is never called with
        // a connection in 'unreachable' state. Branch retained for future-safety only.
        conn.status = 'registered';
        console.log(`[bridge] Session recovered (late pong): ${conn.sessionId}`);
      }
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.sessions.values()) {
        if (conn.status === 'registered') {
          this.sendPing(conn);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private sendPing(conn: InternalConnection): void {
    // Clear any previous outstanding ping before sending a new one.
    this.clearPingState(conn);

    const id = randomUUID();
    conn.pendingPingId = id;
    conn.send({ type: 'ping', id, sessionId: conn.sessionId });

    // ADR-7: pong window (5 s), then grace period (15 s).
    conn.pongTimeoutHandle = setTimeout(() => {
      conn.pongTimeoutHandle = undefined;

      conn.graceTimeoutHandle = setTimeout(() => {
        conn.graceTimeoutHandle = undefined;
        // Only evict if this is still the outstanding ping (no late pong arrived).
        if (conn.pendingPingId === id) {
          conn.pendingPingId = undefined;
          conn.status = 'unreachable';
          console.warn(`[bridge] Session unreachable (missed pong): ${conn.sessionId}`);
          this.sessions.delete(conn.sessionId);
          conn.socket.destroy();
          this._emitter.emit('session.disconnected', conn.sessionId);
        }
      }, GRACE_PERIOD_MS);
    }, PONG_WINDOW_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private findConnectionBySocket(socket: net.Socket): InternalConnection | undefined {
    for (const conn of this.sessions.values()) {
      if (conn.socket === socket) return conn;
    }
    return undefined;
  }

  private clearPingState(conn: InternalConnection): void {
    if (conn.pongTimeoutHandle !== undefined) {
      clearTimeout(conn.pongTimeoutHandle);
      conn.pongTimeoutHandle = undefined;
    }
    if (conn.graceTimeoutHandle !== undefined) {
      clearTimeout(conn.graceTimeoutHandle);
      conn.graceTimeoutHandle = undefined;
    }
    conn.pendingPingId = undefined;
  }
}
