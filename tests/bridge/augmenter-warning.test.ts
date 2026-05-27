/**
 * R9-6 augmenterWarning protocol enhancement — regression suite.
 *
 * Verifies that registration augmenter failures are communicated via the
 * `augmenterWarning` field in the `session.registered` acknowledgement:
 *
 *   1. Augmenter throws → `augmenterWarning` contains error class name (not message).
 *   2. Augmenter succeeds → no `augmenterWarning` field in the message.
 *   3. Augmenter fails → no `mode`/`topicId` fields leak from the failed call.
 *
 * Transport: ExtensionBridge with mocked internals (handleLine).
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type * as net from 'node:net';
import { ExtensionBridge } from '../../src/bridge/extensionBridge.js';
import type { PipeAuthConfig } from '../../src/bridge/pipeAuth.js';
import type { RegistrationAugmenter, RegisteredMessage } from '../../src/bridge/protocol.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

class TestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestError';
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

interface BridgeInternals {
  handleLine(socket: net.Socket, line: string): Promise<void>;
}

function createBridge(): ExtensionBridge {
  return new ExtensionBridge({
    pipeName: 'reach-test',
    pipePath: '\\\\.\\pipe\\reach-test',
    token: 'a'.repeat(64),
  } satisfies PipeAuthConfig);
}

async function sendHello(
  bridge: ExtensionBridge,
  socket: PassThrough,
  sessionId: string,
): Promise<RegisteredMessage | undefined> {
  // Capture socket write before sending hello
  const chunks: string[] = [];
  socket.on('data', (chunk) => {
    chunks.push(chunk.toString());
  });

  const internals = bridge as unknown as BridgeInternals;
  const helloMsg = JSON.stringify({
    type: 'hello',
    sessionId,
    sessionName: `reach-${sessionId}`,
    cwd: 'test-cwd',
    authToken: 'a'.repeat(64),
  });

  await internals.handleLine(socket as unknown as net.Socket, helloMsg);
  await flush();

  // Parse session.registered from socket write buffer
  const joined = chunks.join('');
  const lines = joined.split('\n').filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'session.registered') {
        return msg as RegisteredMessage;
      }
    } catch {
      // skip malformed lines
    }
  }
  return undefined;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('R9-6 augmenterWarning — registration augmenter failure handling', () => {
  // ── 1. Augmenter throws → augmenterWarning contains error class name ────────

  it('augmenter throws TestError → augmenterWarning = "TestError" (not message)', async () => {
    const bridge = createBridge();
    const failingAugmenter: RegistrationAugmenter = async () => {
      throw new TestError('secret filesystem path leaked here');
    };
    bridge.setRegistrationAugmenter(failingAugmenter);

    const socket = new PassThrough();
    const registered = await sendHello(bridge, socket, 'sess-augfail');

    expect(registered).toBeDefined();
    expect(registered?.augmenterWarning).toBe('TestError');
    expect(registered?.mode).toBeUndefined();
    expect(registered?.topicId).toBeUndefined();
  });

  // ── 2. Augmenter succeeds → no augmenterWarning field ───────────────────────

  it('augmenter succeeds → no augmenterWarning field in session.registered', async () => {
    const bridge = createBridge();
    const successAugmenter: RegistrationAugmenter = async () => ({
      mode: { active: false, since: '2025-01-01T00:00:00Z' },
    });
    bridge.setRegistrationAugmenter(successAugmenter);

    const socket = new PassThrough();
    const registered = await sendHello(bridge, socket, 'sess-augsuccess');

    expect(registered).toBeDefined();
    expect(registered?.augmenterWarning).toBeUndefined();
    expect(registered?.mode).toBeDefined();
    expect(registered?.mode?.active).toBe(false);
  });

  // ── 3. Non-Error thrown → augmenterWarning = 'UnknownError' ─────────────────

  it('augmenter throws non-Error → augmenterWarning = "UnknownError"', async () => {
    const bridge = createBridge();
    const failingAugmenter: RegistrationAugmenter = async () => {
      throw 'string error'; // eslint-disable-line @typescript-eslint/only-throw-error
    };
    bridge.setRegistrationAugmenter(failingAugmenter);

    const socket = new PassThrough();
    const registered = await sendHello(bridge, socket, 'sess-unknown');

    expect(registered).toBeDefined();
    expect(registered?.augmenterWarning).toBe('UnknownError');
    expect(registered?.mode).toBeUndefined();
    expect(registered?.topicId).toBeUndefined();
  });
});
