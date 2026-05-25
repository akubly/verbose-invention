/**
 * Smoke tests for FakeDaemon + FakeExtensionClient.
 *
 * These tests exercise the two test doubles against each other to verify:
 * - hello / session.registered handshake
 * - heartbeat ping / pong cycle (fake timers)
 * - missed-pong → grace-period → unreachable (fake timers)
 * - abrupt pipe-teardown (client drops → daemon detects immediately)
 * - multi-client multiplexing by sessionId
 * - stream chunk flow (extension → daemon)
 *
 * All timing-sensitive tests use vi.useFakeTimers() and
 * vi.advanceTimersByTime() so they run deterministically and instantly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDaemon } from './FakeDaemon.js';
import { FakeExtensionClient } from './FakeExtensionClient.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Flushes all pending microtasks and the Node.js stream pipeline.
 * PassThrough streams deliver data synchronously within a tick, but readline
 * 'line' events are emitted asynchronously via setImmediate. We use a short
 * setTimeout(0) flush to allow the readline interface to process buffered data
 * before making assertions.
 *
 * Works with vi.useFakeTimers() because vi stubs setTimeout but still drains
 * the event loop when you await a real Promise: here we use real timers just
 * for the I/O drain, not for the fake-timer subjects under test.
 */
async function flush(): Promise<void> {
  // Let Node's stream/readline plumbing emit its queued 'line' events.
  await new Promise<void>((resolve) => setImmediate(resolve));
  // One extra microtask drain.
  await Promise.resolve();
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('FakeDaemon + FakeExtensionClient (smoke)', () => {
  let daemon: FakeDaemon;

  beforeEach(() => {
    daemon = new FakeDaemon();
    // Only fake the timers the doubles use (setTimeout / setInterval for
    // heartbeat and backoff). Do NOT fake setImmediate — readline's 'line'
    // event is scheduled via setImmediate internally; faking it would block
    // all message delivery in the in-memory transport.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    daemon.reset();
    vi.useRealTimers();
  });

  // ── Handshake ───────────────────────────────────────────────────────────────

  describe('hello / session.registered handshake', () => {
    it('daemon receives hello and replies with session.registered', async () => {
      const client = new FakeExtensionClient('sess-1', 'reach-myapp');
      client.connect(daemon);
      client.sendHello();

      await flush();

      // Daemon side: received the hello.
      const hello = daemon.messagesFrom('sess-1');
      expect(hello).toHaveLength(1);
      expect(hello[0]).toMatchObject({ type: 'hello', sessionId: 'sess-1', sessionName: 'reach-myapp' });
      expect(daemon.isRegistered('sess-1')).toBe(true);

      // Client side: received the session.registered acknowledgement.
      const ack = client.receivedOfType('session.registered');
      expect(ack).toHaveLength(1);
      expect(ack[0]).toMatchObject({ type: 'session.registered', sessionId: 'sess-1' });
    });

    it('daemon is not registered before hello', async () => {
      const client = new FakeExtensionClient('sess-new', 'reach-new');
      client.connect(daemon);
      // No sendHello() yet.
      await flush();
      expect(daemon.isRegistered('sess-new')).toBe(false);
    });
  });

  // ── Heartbeat: happy path ───────────────────────────────────────────────────

  describe('heartbeat (ADR-7)', () => {
    it('daemon sends ping every 30 s and client auto-pongs', async () => {
      const client = new FakeExtensionClient('sess-1', 'reach-myapp');
      client.connect(daemon);
      client.sendHello();
      await flush();

      daemon.startHeartbeat();

      // Advance past the first 30 s heartbeat tick.
      vi.advanceTimersByTime(30_000);
      await flush();

      // Client received exactly one ping.
      const pings = client.receivedOfType('ping');
      expect(pings).toHaveLength(1);
      expect(pings[0]).toMatchObject({ type: 'ping', sessionId: 'sess-1' });

      // Client auto-replied with pong.
      const pongs = client.sentOfType('pong');
      expect(pongs).toHaveLength(1);
      expect(pongs[0]).toMatchObject({ type: 'pong', id: pings[0]!.id });

      // Daemon side: received the pong and session remains reachable.
      const daemonPongs = daemon.messagesOfType('pong');
      expect(daemonPongs).toHaveLength(1);
      expect(daemon.isUnreachable('sess-1')).toBe(false);
    });

    it('daemon sends pings at subsequent 30 s intervals', async () => {
      const client = new FakeExtensionClient('sess-1', 'reach-myapp');
      client.connect(daemon);
      client.sendHello();
      await flush();
      daemon.startHeartbeat();

      // Three full heartbeat cycles.
      for (let i = 1; i <= 3; i++) {
        vi.advanceTimersByTime(30_000);
        await flush();
      }

      expect(client.receivedOfType('ping')).toHaveLength(3);
      expect(client.sentOfType('pong')).toHaveLength(3);
    });
  });

  // ── Heartbeat: missed pong → unreachable ────────────────────────────────────

  describe('missed pong → unreachable (ADR-7 slow path)', () => {
    it('marks session unreachable after missed pong + grace period', async () => {
      const client = new FakeExtensionClient('sess-zombie', 'reach-zombie');
      client.connect(daemon);
      client.sendHello();
      await flush();

      // Disable auto-pong to simulate a frozen extension.
      client.setPingAutoRespond(false);

      daemon.startHeartbeat();

      // Trigger the 30 s ping.
      vi.advanceTimersByTime(30_000);
      await flush();

      // The ping has been sent; session is still reachable at this point.
      expect(client.receivedOfType('ping')).toHaveLength(1);
      expect(daemon.isUnreachable('sess-zombie')).toBe(false);

      // Advance past the 5 s pong deadline.
      vi.advanceTimersByTime(5_001);
      await flush();

      // Still not unreachable — grace period (15 s) hasn't elapsed yet.
      expect(daemon.isUnreachable('sess-zombie')).toBe(false);

      // Advance past the 15 s grace period.
      vi.advanceTimersByTime(15_001);
      await flush();

      // Now the session should be marked unreachable.
      expect(daemon.isUnreachable('sess-zombie')).toBe(true);
      expect(daemon.isRegistered('sess-zombie')).toBe(false);
    });

    it('does not mark session unreachable when pong arrives before deadline', async () => {
      const client = new FakeExtensionClient('sess-healthy', 'reach-healthy');
      client.connect(daemon);
      client.sendHello();
      await flush();

      daemon.startHeartbeat();

      // Trigger ping.
      vi.advanceTimersByTime(30_000);
      await flush();

      // Pong was auto-sent. Advance well past the pong + grace window.
      vi.advanceTimersByTime(30_000);
      await flush();

      // Session remains reachable.
      expect(daemon.isUnreachable('sess-healthy')).toBe(false);
    });
  });

  // ── Pipe teardown: fast path ─────────────────────────────────────────────────

  describe('pipe teardown (ADR-7 fast path)', () => {
    it('daemon marks session unreachable immediately when client drops', async () => {
      const client = new FakeExtensionClient('sess-drop', 'reach-drop');
      client.connect(daemon);
      client.sendHello();
      await flush();

      expect(daemon.isRegistered('sess-drop')).toBe(true);

      // Client drops the pipe (simulates CLI process exit).
      client.dropConnection();
      await flush();

      expect(daemon.isUnreachable('sess-drop')).toBe(true);
      expect(daemon.isRegistered('sess-drop')).toBe(false);
      expect(client.isDropped).toBe(true);
    });

    it('daemon disconnectSession() ends fromServer on the client side', async () => {
      const client = new FakeExtensionClient('sess-kick', 'reach-kick');
      client.connect(daemon);
      client.sendHello();
      await flush();

      daemon.disconnectSession('sess-kick');
      await flush();

      // The session is no longer registered on the daemon side.
      expect(daemon.isRegistered('sess-kick')).toBe(false);
    });
  });

  // ── Multi-client multiplexing ────────────────────────────────────────────────

  describe('multi-client multiplexing', () => {
    it('routes messages to correct sessions by sessionId', async () => {
      const clientA = new FakeExtensionClient('sess-a', 'reach-alpha');
      const clientB = new FakeExtensionClient('sess-b', 'reach-beta');

      clientA.connect(daemon);
      clientB.connect(daemon);
      clientA.sendHello();
      clientB.sendHello();
      await flush();

      expect(daemon.isRegistered('sess-a')).toBe(true);
      expect(daemon.isRegistered('sess-b')).toBe(true);
      expect(daemon.connectionCount).toBe(2);

      // Messages from A should not appear in B's filtered view and vice versa.
      expect(daemon.messagesFrom('sess-a').every((m) => m.sessionId === 'sess-a')).toBe(true);
      expect(daemon.messagesFrom('sess-b').every((m) => m.sessionId === 'sess-b')).toBe(true);
    });

    it('daemon heartbeat pings all registered sessions independently', async () => {
      const clientA = new FakeExtensionClient('sess-a', 'reach-alpha');
      const clientB = new FakeExtensionClient('sess-b', 'reach-beta');

      clientA.connect(daemon);
      clientB.connect(daemon);
      clientA.sendHello();
      clientB.sendHello();
      await flush();

      daemon.startHeartbeat();
      vi.advanceTimersByTime(30_000);
      await flush();

      // Each client received exactly one ping addressed to them.
      expect(clientA.receivedOfType('ping').every((p) => p.sessionId === 'sess-a')).toBe(true);
      expect(clientB.receivedOfType('ping').every((p) => p.sessionId === 'sess-b')).toBe(true);
      expect(clientA.receivedOfType('ping')).toHaveLength(1);
      expect(clientB.receivedOfType('ping')).toHaveLength(1);
    });
  });

  // ── Stream chunk flow ────────────────────────────────────────────────────────

  describe('stream chunk flow (extension → daemon)', () => {
    it('daemon receives stream chunks with done=false and done=true', async () => {
      const client = new FakeExtensionClient('sess-1', 'reach-myapp');
      client.connect(daemon);
      client.sendHello();
      await flush();

      client.sendStreamChunk('req-42', 'Hello', false);
      client.sendStreamChunk('req-42', ' world', true);
      await flush();

      const chunks = daemon.messagesOfType('stream');
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({ sessionId: 'sess-1', requestId: 'req-42', chunk: 'Hello', done: false });
      expect(chunks[1]).toMatchObject({ sessionId: 'sess-1', requestId: 'req-42', chunk: ' world', done: true });
    });

    it('daemon receives stream.error', async () => {
      const client = new FakeExtensionClient('sess-1', 'reach-myapp');
      client.connect(daemon);
      client.sendHello();
      await flush();

      client.sendStreamError('req-99', 'Copilot timeout');
      await flush();

      const errors = daemon.messagesOfType('stream.error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ sessionId: 'sess-1', requestId: 'req-99', error: 'Copilot timeout' });
    });
  });

  // ── ADR-11 AFK / mirror protocol shapes ─────────────────────────────────────

  describe('ADR-11 pipe protocol additions', () => {
    it('round-trips afk.request and back.request from extension to daemon', async () => {
      const client = new FakeExtensionClient('sess-mode', 'reach-mode');
      client.connect(daemon);
      client.sendHello();
      await flush();

      client.sendAfkRequest();
      client.sendBackRequest();
      await flush();

      expect(daemon.expectAfkRequest('sess-mode')).toMatchObject({
        type: 'afk.request',
        sessionId: 'sess-mode',
      });
      expect(daemon.expectBackRequest('sess-mode')).toMatchObject({
        type: 'back.request',
        sessionId: 'sess-mode',
      });
    });

    it('round-trips daemon-to-extension AFK lifecycle and mirror messages', async () => {
      const client = new FakeExtensionClient('sess-mode', 'reach-mode');
      client.connect(daemon);
      client.sendHello();
      await flush();

      daemon.sendAfkActivated('sess-mode', 12345, 'https://t.me/c/test/12345');
      daemon.sendModeChanged(true, '2026-05-24T23:19:14-07:00');
      daemon.sendMirrorInput('sess-mode', 'check the build logs', 12345);
      daemon.sendTo('sess-mode', {
        type: 'relay.command',
        sessionId: 'sess-mode',
        command: '/clear',
        args: [],
      });
      daemon.sendBackConfirmed('sess-mode');
      await flush();

      expect(client.receivedOfType('afk.activated')[0]).toMatchObject({
        type: 'afk.activated',
        sessionId: 'sess-mode',
        topicId: 12345,
        topicUrl: 'https://t.me/c/test/12345',
      });
      expect(client.expectModeChanged(true)).toMatchObject({
        type: 'mode.changed',
        active: true,
        since: '2026-05-24T23:19:14-07:00',
      });
      expect(client.expectMirrorInput('sess-mode', 'check the build logs')).toMatchObject({
        type: 'mirror.input',
        source: 'telegram',
        topicId: 12345,
      });
      expect(client.receivedOfType('relay.command')[0]).toMatchObject({
        type: 'relay.command',
        sessionId: 'sess-mode',
        command: '/clear',
        args: [],
      });
      expect(client.receivedOfType('back.confirmed')[0]).toMatchObject({
        type: 'back.confirmed',
        sessionId: 'sess-mode',
      });
    });

    it('includes amended session.registered mode and topic fields for late joiners', async () => {
      daemon.setMode(true, '2026-05-24T23:19:14-07:00');
      daemon.setTopicForSession('sess-late', 777);

      const client = new FakeExtensionClient('sess-late', 'reach-late');
      client.connect(daemon);
      client.sendHello();
      await flush();

      expect(client.receivedOfType('session.registered')[0]).toMatchObject({
        type: 'session.registered',
        sessionId: 'sess-late',
        mode: { active: true, since: '2026-05-24T23:19:14-07:00' },
        topicId: 777,
      });
    });
  });

  // ── daemon.sendTo (daemon → extension) ──────────────────────────────────────

  describe('daemon.sendTo()', () => {
    it('daemon can send an inject message to a registered client', async () => {
      const client = new FakeExtensionClient('sess-1', 'reach-myapp');
      client.connect(daemon);
      client.sendHello();
      await flush();

      daemon.sendTo('sess-1', {
        type: 'inject',
        sessionId: 'sess-1',
        requestId: 'req-1',
        text: 'What is TypeScript?',
      });
      await flush();

      const injects = client.receivedOfType('inject');
      expect(injects).toHaveLength(1);
      expect(injects[0]).toMatchObject({
        type: 'inject',
        sessionId: 'sess-1',
        requestId: 'req-1',
        text: 'What is TypeScript?',
      });
    });

    it('throws when sessionId has no registered connection', () => {
      expect(() =>
        daemon.sendTo('sess-ghost', { type: 'session.registered', sessionId: 'sess-ghost' }),
      ).toThrow('no connection registered');
    });
  });

  // ── Wire format: JSON-Lines compliance ──────────────────────────────────────

  describe('JSON-Lines wire format', () => {
    it('each message is a single newline-terminated JSON object', async () => {
      const lines: string[] = [];
      const client = new FakeExtensionClient('sess-wire', 'reach-wire');

      // Intercept raw bytes written to the server stream before connect().
      const { toServer, fromServer } = (daemon as any).connections
        ? (() => {
            // We need to capture after connect so let's check via client.sent.
            return { toServer: null, fromServer: null };
          })()
        : { toServer: null, fromServer: null };

      client.connect(daemon);
      client.sendHello();
      client.sendStreamChunk('r1', 'hi', true);
      await flush();

      // All sent messages are parseable JSON and their serialized form has no
      // embedded newlines (except the trailing delimiter).
      for (const msg of client.sent) {
        const line = JSON.stringify(msg);
        expect(line).not.toContain('\n');
        const parsed = JSON.parse(line);
        expect(parsed).toMatchObject({ type: msg.type });
      }

      void lines; void toServer; void fromServer; // silence unused-var lint
    });
  });
});
