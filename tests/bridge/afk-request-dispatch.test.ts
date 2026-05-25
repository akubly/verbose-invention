import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type * as net from 'node:net';
import { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import type { ExtensionConnection, OutboundMessage } from '../../src/bridge/extensionBridge.js';
import type { PipeAuthConfig } from '../../src/bridge/pipeAuth.js';

interface TestConnection extends ExtensionConnection {
  readonly socket: net.Socket;
  pendingPingId?: string;
  pongTimeoutHandle?: ReturnType<typeof setTimeout>;
  graceTimeoutHandle?: ReturnType<typeof setTimeout>;
}

interface BridgeInternals {
  sessions: Map<string, TestConnection>;
  handleLine(socket: net.Socket, line: string): void;
}

function makeBridgeHarness(sessionId = 'sess-dispatch') {
  const bridge = new ExtensionBridge({
    pipeName: 'reach-test',
    pipePath: '\\\\.\\pipe\\reach-test',
    token: 'a'.repeat(64),
  } satisfies PipeAuthConfig);
  const socket = new PassThrough() as unknown as net.Socket;
  const conn: TestConnection = {
    sessionId,
    sessionName: 'reach-dispatch',
    cwd: 'test-cwd',
    socket,
    status: 'registered',
    send: (_msg: OutboundMessage) => undefined,
  };
  const internals = bridge as unknown as BridgeInternals;
  internals.sessions.set(sessionId, conn);
  return { bridge, internals, socket, sessionId };
}

describe('ExtensionBridge ADR-11 request dispatcher', () => {
  it('emits afk.request and back.request event channels for valid registered sessions', () => {
    const { bridge, internals, socket, sessionId } = makeBridgeHarness();
    const onAfk = vi.fn();
    const onBack = vi.fn();
    bridge.on('afk.request', onAfk);
    bridge.on('back.request', onBack);

    internals.handleLine(socket, JSON.stringify({ type: 'afk.request', sessionId }));
    internals.handleLine(socket, JSON.stringify({ type: 'back.request', sessionId }));

    expect(onAfk).toHaveBeenCalledWith(sessionId);
    expect(onBack).toHaveBeenCalledWith(sessionId);
  });

  it('drops afk.request and back.request when the frame sessionId does not match the pipe session', () => {
    const { bridge, internals, socket } = makeBridgeHarness('sess-real');
    const onAfk = vi.fn();
    const onBack = vi.fn();
    bridge.on('afk.request', onAfk);
    bridge.on('back.request', onBack);

    internals.handleLine(socket, JSON.stringify({ type: 'afk.request', sessionId: 'sess-spoof' }));
    internals.handleLine(socket, JSON.stringify({ type: 'back.request', sessionId: 'sess-spoof' }));

    expect(onAfk).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});
