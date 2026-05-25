/**
 * FakeExtensionClient — in-process stand-in for the CLI extension side.
 *
 * TODO: Once Carter's `carter-pipe-protocol.md` is merged, verify that the
 * message shapes sent/received here match Carter's `extension.mjs` exactly.
 * See `.squad/decisions/inbox/jun-test-doubles-contract.md` for the shapes
 * used here.
 *
 * Transport: pure in-memory PassThrough stream pairs shared with FakeDaemon.
 * No actual named pipe required — tests run on any OS in CI.
 *
 * Fake-timer compatible: auto-pong behaviour is synchronous (fired inside the
 * readline 'line' event handler), so it does not schedule its own timers.
 * Tests control heartbeat timing by advancing vi.useFakeTimers().
 *
 * Usage:
 *   const daemon = new FakeDaemon();
 *   const client = new FakeExtensionClient('sess-1', 'reach-myapp');
 *   client.connect(daemon);
 *   await client.sendHello();
 *   const ack = client.lastReceived();   // { type: 'session.registered', ... }
 *   vi.advanceTimersByTime(30_000);      // fire daemon heartbeat ping cycle
 *   // client has auto-responded with pong; daemon's missed-pong timer cancelled
 *   client.setPingAutoRespond(false);    // disable for dead-extension tests
 *   vi.advanceTimersByTime(30_000 + 5_000 + 15_000); // triggers unreachable
 */

import { PassThrough } from 'stream';
import { createInterface } from 'readline';
import type {
  FakeDaemon,
  InboundMessage,
  OutboundMessage,
  HelloMessage,
  PongMessage,
  StreamChunkMessage,
  StreamErrorMessage,
  AfkRequestMessage,
  BackRequestMessage,
} from './FakeDaemon.js';

// ─── FakeExtensionClient ──────────────────────────────────────────────────────

export class FakeExtensionClient {
  private readonly _sessionId: string;
  private readonly _sessionName: string;

  /** Stream this client writes outbound messages to (daemon reads this). */
  private toServer: PassThrough | null = null;
  /** Stream this client reads inbound messages from (daemon writes this). */
  private fromServer: PassThrough | null = null;

  /** All messages this client has sent to the daemon, in send order. */
  private _sent: InboundMessage[] = [];

  /** All messages this client has received from the daemon, in arrival order. */
  private _received: OutboundMessage[] = [];

  /** When true, the client automatically responds to each `ping` with a `pong`. */
  private _autoPong = true;

  /** Whether this client has called connect() successfully. */
  private _connected = false;

  /** Whether this client has deliberately dropped its connection. */
  private _dropped = false;

  constructor(sessionId: string, sessionName: string) {
    this._sessionId = sessionId;
    this._sessionName = sessionName;
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────────

  /**
   * Wires this client to a FakeDaemon via in-memory streams.
   * Must be called before any send* methods.
   */
  connect(daemon: FakeDaemon): void {
    if (this._connected) {
      throw new Error('FakeExtensionClient: already connected');
    }
    const { toServer, fromServer } = daemon.accept();
    this.toServer = toServer;
    this.fromServer = fromServer;
    this._connected = true;
    this._dropped = false;

    // Wire readline parser for messages arriving from the daemon.
    const rl = createInterface({ input: fromServer, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let msg: OutboundMessage;
      try {
        msg = JSON.parse(line) as OutboundMessage;
      } catch {
        return; // malformed — ignore
      }
      this._received.push(msg);
      this._handleInbound(msg);
    });

    fromServer.on('end', () => {
      this._connected = false;
    });
  }

  /**
   * Simulates the client dropping its connection (e.g. CLI process exit).
   * Ends the write-side of the stream to the daemon, triggering the fast-path
   * pipe-teardown detection on the daemon side (ADR-7).
   */
  dropConnection(): void {
    if (!this.toServer) {
      throw new Error('FakeExtensionClient: not connected');
    }
    this.toServer.end();
    this._dropped = true;
    this._connected = false;
  }

  // ── Send helpers ─────────────────────────────────────────────────────────────

  /**
   * Sends the ADR-2 `hello` registration message (extension → daemon).
   * Protocol: { type: 'hello', sessionId, sessionName[, authToken] }
   * Pass `authToken` when testing ADR-10 auth scenarios.
   */
  sendHello(authToken?: string): void {
    const msg: HelloMessage = {
      type: 'hello',
      sessionId: this._sessionId,
      sessionName: this._sessionName,
      ...(authToken !== undefined && { authToken }),
    };
    this._write(msg);
  }

  /**
   * Sends a `pong` reply to the given ping id (extension → daemon).
   * Normally called automatically when `autoPong` is enabled.
   */
  sendPong(pingId: string): void {
    const msg: PongMessage = {
      type: 'pong',
      id: pingId,
      sessionId: this._sessionId,
    };
    this._write(msg);
  }

  /**
   * Sends a stream chunk (CLI response → daemon → relay).
   * Set `done: true` on the final chunk.
   */
  sendStreamChunk(requestId: string, chunk: string, done = false): void {
    const msg: StreamChunkMessage = {
      type: 'stream',
      sessionId: this._sessionId,
      requestId,
      chunk,
      done,
    };
    this._write(msg);
  }

  /**
   * Sends a stream-error notification (CLI error → daemon → relay).
   */
  sendStreamError(requestId: string, error: string): void {
    const msg: StreamErrorMessage = {
      type: 'stream.error',
      sessionId: this._sessionId,
      requestId,
      error,
    };
    this._write(msg);
  }

  /** Sends ADR-11 afk.request (extension → daemon). */
  sendAfkRequest(): void {
    const msg: AfkRequestMessage = { type: 'afk.request', sessionId: this._sessionId };
    this._write(msg);
  }

  /** Sends ADR-11 back.request (extension → daemon). */
  sendBackRequest(): void {
    const msg: BackRequestMessage = { type: 'back.request', sessionId: this._sessionId };
    this._write(msg);
  }

  /** Sends ADR-8 session.event (extension → daemon). */
  sendSessionEvent(payload: unknown): void {
    this._write({ type: 'session.event', sessionId: this._sessionId, payload });
  }

  /** Low-level: write any raw InboundMessage to the wire. */
  sendRaw(msg: InboundMessage): void {
    this._write(msg);
  }

  // ── Auto-pong control ─────────────────────────────────────────────────────────

  /**
   * Enable or disable automatic pong replies.
   * Disable to simulate a zombie extension that stops responding (ADR-7
   * slow-path tests: missed pong → grace period → unreachable).
   */
  setPingAutoRespond(enabled: boolean): void {
    this._autoPong = enabled;
  }

  /** Current auto-pong setting. */
  get pingAutoRespond(): boolean {
    return this._autoPong;
  }

  // ── Query / assertion helpers ─────────────────────────────────────────────────

  /** All messages this client has sent to the daemon, in send order. */
  get sent(): InboundMessage[] {
    return this._sent;
  }

  /** All messages this client has received from the daemon, in arrival order. */
  get received(): OutboundMessage[] {
    return this._received;
  }

  /** Last message received from the daemon, or undefined. */
  lastReceived(): OutboundMessage | undefined {
    return this._received[this._received.length - 1];
  }

  /** Last message sent to the daemon, or undefined. */
  lastSent(): InboundMessage | undefined {
    return this._sent[this._sent.length - 1];
  }

  /** All received messages of a specific type. */
  receivedOfType<T extends OutboundMessage['type']>(
    type: T,
  ): Extract<OutboundMessage, { type: T }>[] {
    return this._received.filter(
      (m): m is Extract<OutboundMessage, { type: T }> => m.type === type,
    );
  }

  /** All sent messages of a specific type. */
  sentOfType<T extends InboundMessage['type']>(
    type: T,
  ): Extract<InboundMessage, { type: T }>[] {
    return this._sent.filter(
      (m): m is Extract<InboundMessage, { type: T }> => m.type === type,
    );
  }

  /** Returns the first received afk.activated message or throws. */
  expectAfkActivated(topicId?: number): Extract<OutboundMessage, { type: 'afk.activated' }> {
    const msg = this.receivedOfType('afk.activated').find((m) => topicId === undefined || m.topicId === topicId);
    if (!msg) throw new Error(`Expected afk.activated${topicId === undefined ? '' : ` for topic ${topicId}`}`);
    return msg;
  }

  /** Returns the first received mode.changed message matching active or throws. */
  expectModeChanged(active: boolean): Extract<OutboundMessage, { type: 'mode.changed' }> {
    const msg = this.receivedOfType('mode.changed').find((m) => m.active === active);
    if (!msg) throw new Error(`Expected mode.changed active=${active}`);
    return msg;
  }

  /** Returns the first received mirror.input message matching session/text or throws. */
  expectMirrorInput(sessionId: string, text: string): Extract<OutboundMessage, { type: 'mirror.input' }> {
    const msg = this.receivedOfType('mirror.input').find((m) => m.sessionId === sessionId && m.text === text);
    if (!msg) throw new Error(`Expected mirror.input for ${sessionId}: ${text}`);
    return msg;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get sessionName(): string {
    return this._sessionName;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get isDropped(): boolean {
    return this._dropped;
  }

  // ── Reset ────────────────────────────────────────────────────────────────────

  /**
   * Clears sent/received message logs. Does not touch the connection.
   * Useful when you want to assert on messages after a specific action.
   */
  clearLogs(): void {
    this._sent = [];
    this._received = [];
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _write(msg: InboundMessage): void {
    if (!this.toServer || !this._connected) {
      throw new Error(
        `FakeExtensionClient: cannot send "${msg.type}" — not connected. Call connect(daemon) first.`,
      );
    }
    this._sent.push(msg);
    this.toServer.write(JSON.stringify(msg) + '\n');
  }

  private _handleInbound(msg: OutboundMessage): void {
    if (msg.type === 'ping' && this._autoPong) {
      // Auto-respond to heartbeat pings.
      this.sendPong(msg.id);
    }
  }
}
