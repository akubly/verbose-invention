/**
 * extensionBridge.ts — Named-pipe server (daemon side).
 *
 * Listens on \\.\pipe\reach-bridge (single pipe, multiplexed by sessionId).
 * Each CLI extension instance connects, sends a `register` message, and is
 * tracked in a Map<sessionId, ExtensionConnection>.
 *
 * Protocol: UTF-8 JSON-Lines (one JSON object per newline-terminated line).
 *           Max 64 KB per line (ADR-3).
 *
 * Heartbeat: daemon sends `ping` every 30 s (ADR-7). Extension must reply
 *            `pong` within 5 s; if missed, a 15 s grace period begins.
 *            After grace expires without pong the session is marked
 *            unreachable and evicted. Normal pipe teardown is detected
 *            immediately via the `close` event (fast path, <1 s).
 *
 * ADR compliance: ADR-3 (single pipe), ADR-4 (crash = unreachable),
 *                 ADR-5 (user-level daemon), ADR-7 (ping/pong + teardown).
 */

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────────────────

export const PIPE_PATH = '\\\\.\\pipe\\reach-bridge';
const HEARTBEAT_INTERVAL_MS = 30_000;
/** ADR-7: pong expected within this many ms after a ping is sent. */
const PONG_WINDOW_MS = 5_000;
/** ADR-7: grace period after missed pong before marking session unreachable. */
const GRACE_PERIOD_MS = 15_000;
/** ADR-3: max bytes per JSON-Lines frame (64 KB). */
const MAX_LINE_BYTES = 64 * 1024;

// ── Protocol message types ────────────────────────────────────────────────────
//
// Inbound (extension → daemon)

/** First message from every new extension connection. */
export interface RegisterMessage {
  type: 'register';
  sessionId: string;
}

/** Heartbeat reply from extension. `id` must echo the ping's `id`. */
export interface PongMessage {
  type: 'pong';
  id: string;
}

/** CLI session event forwarded from the extension to the daemon. */
export interface SessionEventMessage {
  type: 'session.event';
  sessionId: string;
  payload: unknown;
}

/** Result of a `session.command` that the daemon previously sent. */
export interface SessionCommandResultMessage {
  type: 'session.command-result';
  sessionId: string;
  payload: unknown;
}

export type InboundMessage =
  | RegisterMessage
  | PongMessage
  | SessionEventMessage
  | SessionCommandResultMessage;

//
// Outbound (daemon → extension)

/** Acknowledgement sent after successful `register`. */
export interface RegisteredMessage {
  type: 'registered';
  sessionId: string;
}

/** Heartbeat probe. Extension must reply `pong` with the same `id`. */
export interface PingMessage {
  type: 'ping';
  id: string;
}

/** Command injected into the CLI session by the daemon. */
export interface SessionCommandMessage {
  type: 'session.command';
  sessionId: string;
  payload: unknown;
}

export type OutboundMessage =
  | RegisteredMessage
  | PingMessage
  | SessionCommandMessage;

// ── Connection state ─────────────────────────────────────────────────────────

/** Status of an extension session. */
export type ConnectionStatus = 'registered' | 'unreachable';

/** Public handle for a registered extension connection. */
export interface ExtensionConnection {
  readonly sessionId: string;
  readonly status: ConnectionStatus;
  /** Send a typed outbound message to this extension. */
  send(msg: OutboundMessage): void;
}

/** Internal implementation — includes mutable status and heartbeat bookkeeping. */
interface InternalConnection extends ExtensionConnection {
  status: ConnectionStatus;
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
 * - `session.registered`     — extension connected and registered
 * - `session.disconnected`   — pipe closed or heartbeat timed out (session evicted)
 * - `session.event`          — CLI event forwarded by the extension
 * - `session.command-result` — result of a daemon-injected command
 */
export interface BridgeEmitter {
  on(event: 'session.registered', listener: (sessionId: string) => void): this;
  on(event: 'session.disconnected', listener: (sessionId: string) => void): this;
  on(event: 'session.event', listener: (sessionId: string, payload: unknown) => void): this;
  on(
    event: 'session.command-result',
    listener: (sessionId: string, payload: unknown) => void,
  ): this;
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
  /** Sockets that have connected but not yet sent `register`. */
  private readonly pendingSockets = new Set<net.Socket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── BridgeEmitter implementation ─────────────────────────────────────────

  on(event: 'session.registered', listener: (sessionId: string) => void): this;
  on(event: 'session.disconnected', listener: (sessionId: string) => void): this;
  on(event: 'session.event', listener: (sessionId: string, payload: unknown) => void): this;
  on(
    event: 'session.command-result',
    listener: (sessionId: string, payload: unknown) => void,
  ): this;
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

      server.listen(PIPE_PATH, () => {
        this.server = server;
        this.startHeartbeat();
        console.log(`[bridge] Listening on ${PIPE_PATH}`);
        resolve();
      });
    });
  }

  /**
   * Gracefully stop the server, cancel all heartbeat timers, and destroy
   * every open socket. Resolves when the server is fully closed.
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

    return new Promise<void>((resolve) => {
      if (this.server === null) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
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

  /**
   * Send a command payload to an extension identified by `sessionId`.
   * Returns `true` if the message was sent, `false` if the session is
   * not registered or is unreachable.
   */
  sendCommand(sessionId: string, payload: unknown): boolean {
    const conn = this.sessions.get(sessionId);
    if (conn === undefined || conn.status !== 'registered') return false;
    conn.send({ type: 'session.command', sessionId, payload });
    return true;
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    this.pendingSockets.add(socket);

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
      case 'register':
        this.handleRegister(socket, msg as RegisterMessage);
        break;
      case 'pong':
        if (conn !== undefined) this.handlePong(conn, msg as PongMessage);
        break;
      case 'session.event':
        if (conn !== undefined) {
          this._emitter.emit('session.event', conn.sessionId, (msg as SessionEventMessage).payload);
        }
        break;
      case 'session.command-result':
        if (conn !== undefined) {
          this._emitter.emit(
            'session.command-result',
            conn.sessionId,
            (msg as SessionCommandResultMessage).payload,
          );
        }
        break;
      default:
        console.warn(`[bridge] Unknown message type "${String(type)}" — ignoring`);
    }
  }

  private handleRegister(socket: net.Socket, msg: RegisterMessage): void {
    const { sessionId } = msg;

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      console.warn('[bridge] register message missing sessionId — closing connection');
      socket.destroy();
      return;
    }

    // Evict any stale connection for the same sessionId (extension reconnected
    // after daemon restart per ADR-6 backoff policy).
    const stale = this.sessions.get(sessionId);
    if (stale !== undefined && stale.socket !== socket) {
      console.log(`[bridge] Replacing stale connection for session ${sessionId}`);
      this.clearPingState(stale);
      stale.socket.destroy();
    }

    const conn: InternalConnection = {
      sessionId,
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

    conn.send({ type: 'registered', sessionId });
    console.log(`[bridge] Session registered: ${sessionId}`);
    this._emitter.emit('session.registered', sessionId);
  }

  private handlePong(conn: InternalConnection, msg: PongMessage): void {
    if (conn.pendingPingId !== undefined && conn.pendingPingId === msg.id) {
      this.clearPingState(conn);
      if (conn.status === 'unreachable') {
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
    conn.send({ type: 'ping', id });

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
