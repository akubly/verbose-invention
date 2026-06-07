/**
 * relay.cycle1.test.ts — Cycle-1 regression verification (B1 + I2)
 *
 * B1 — Relay uses the abstract ChannelPort path uniformly; no
 *      formatForTransport pre-call, no TelegramChannel duck-typing.
 *
 * I2 — editMessage returning false propagates through safeEdit and triggers
 *      the "failed to render reply" fallback path.
 *
 * These tests drive the REAL Relay with a non-Telegram mock channel and would
 * FAIL on the pre-fix relay that duck-typed TelegramChannel and didn't
 * propagate the boolean return of editMessage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { SessionEntry } from '../../src/sessions/registry.js';
import type { ChannelPort, ChannelCapabilities, ChannelContext } from '../../src/channel/port.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMockChannel(): ChannelPort & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
  formatForTransport: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue({ id: '100' });
  const editMessage = vi.fn().mockResolvedValue(true);
  const formatForTransport = vi.fn((text: string) => text);
  return {
    name: 'fake',
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage,
    editMessage,
    splitMessage: vi.fn((text: string, footer?: string) => {
      const full = footer ? `${text}\n\n${footer}` : text;
      return [full];
    }),
    formatForTransport,
    createThread: vi.fn(),
    onMessage: vi.fn(),
    onCommand: vi.fn(),
    promptUser: vi.fn().mockResolvedValue('approve'),
    capabilities: {
      supportsMessageEdit: true,
      supportsThreadCreation: true,
      supportsInteractivePrompts: true,
      supportsStreaming: true,
      maxMessageLength: 4096,
    },
  } as unknown as ChannelPort & {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessage: ReturnType<typeof vi.fn>;
    formatForTransport: ReturnType<typeof vi.fn>;
  };
}

function makeCapabilityChannel(overrides: Partial<ChannelCapabilities>): ReturnType<typeof makeMockChannel> {
  const base = makeMockChannel();
  (base as unknown as { capabilities: ChannelCapabilities }).capabilities = {
    ...base.capabilities,
    ...overrides,
  };
  return base;
}

const DEFAULT_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };
const DEFAULT_TEXT = 'Hello Copilot';

function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.threadId, e]));
  return { resolve: vi.fn((threadId: string) => map.get(threadId)) };
}

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  threadId: '42',
  channelId: '-1001234567890',
  createdAt: '2024-01-01T00:00:00.000Z',
};

// ─── B1 — relay passes RAW text; no formatForTransport call by relay ──────────
//
// REGRESSION: Before the B1 fix, relay.ts duck-typed TelegramChannel:
//   if ('editMessageWithMarkdown' in channel) {
//     await (channel as TelegramChannel).editMessageWithMarkdown(ctx, ref, text);
//   } else {
//     await channel.sendMessage(ctx, channel.formatForTransport(text));
//   }
// Non-Telegram channels received pre-formatted text via channel.formatForTransport
// on the relay side — double-formatting would occur if the adapter also formatted.
//
// Fixed relay: all three Cases call channel.sendMessage/editMessage with raw text.
// The adapter (TelegramChannel, FakeChannel, etc.) is the sole formatter.

describe('B1 — relay passes RAW text, never calls formatForTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('B1a: formatForTransport is never called by the relay (Case A — streaming+edit)', async () => {
    const session = makeMockSession(['**bold** text with _italic_ and [links](http://x.com)']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: true, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    // Relay MUST NOT call formatForTransport — the adapter owns formatting.
    expect(channel.formatForTransport).not.toHaveBeenCalled();
  });

  it('B1b: formatForTransport is never called by the relay (Case B — no-edit)', async () => {
    const session = makeMockSession(['raw text with *asterisks* and \\backslashes\\']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsMessageEdit: false });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.formatForTransport).not.toHaveBeenCalled();
  });

  it('B1c: formatForTransport is never called by the relay (Case C — no-stream)', async () => {
    const session = makeMockSession(['text with `code` and >block quotes']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: false, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    expect(channel.formatForTransport).not.toHaveBeenCalled();
  });

  it('B1d: relay passes raw session text to channel.editMessage (adapter formats internally)', async () => {
    // The session yields a string that would look different if escaped.
    // The relay MUST pass it unchanged to editMessage — TelegramChannel escapes
    // internally; a non-Telegram adapter receives the raw text and may ignore escaping.
    const RAW = '**bold** _italic_ `code` [link](http://example.com)';
    const session = makeMockSession([RAW]);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: true, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    // Final editMessage must contain the RAW text (not escaped or pre-formatted).
    const editCalls = channel.editMessage.mock.calls;
    const lastEditText = editCalls[editCalls.length - 1][2] as string;
    expect(lastEditText).toContain(RAW);
  });

  it('B1e: relay passes raw session text to channel.sendMessage in Case B (no-edit path)', async () => {
    const RAW = '**bold** _italic_ raw text';
    const session = makeMockSession([RAW]);
    const factory = makeMockFactory(session);
    // Case B: no edits — one final sendMessage with full accumulated text.
    const channel = makeCapabilityChannel({ supportsMessageEdit: false });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    // sendMessage called once with the full accumulated raw text.
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    const sendText = channel.sendMessage.mock.calls[0][1] as string;
    expect(sendText).toContain(RAW);
    expect(channel.formatForTransport).not.toHaveBeenCalled();
  });
});

// ─── I2 — editMessage returning false triggers "failed to render reply" ────────
//
// REGRESSION: Before the I2 fix, safeEdit() always returned true regardless of
// what channel.editMessage() returned:
//   private async safeEdit(...): Promise<boolean> {
//     try {
//       await this.channel.editMessage(ctx, ref, text);
//       return true;  // ← boolean return value of editMessage ignored!
//     } catch { return false; }
//   }
//
// So when an adapter's editMessage() returned false (e.g., on a rate-limited or
// failed edit), safeEdit() returned true, firstOk was true, and the relay
// reported success — the user saw no message or error indicator.
//
// Fixed safeEdit():
//   return await this.channel.editMessage(ctx, ref, text);
//   // Now false propagates → firstOk=false → fallback fires.

describe('I2 — editMessage false return propagates to "failed to render reply" fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('I2a (Case A): editMessage returning false triggers fallback text "_(failed to render reply — see logs)_"', async () => {
    const session = makeMockSession(['Hello world']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: true, supportsMessageEdit: true });

    // Make ALL editMessage calls return false (simulates adapter soft-failure, not throw).
    // Pre-fix: safeEdit would return true despite this — no fallback would fire.
    // Post-fix: safeEdit propagates false → firstOk=false → fallback fires.
    channel.editMessage.mockResolvedValue(false);

    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    // The relay must have attempted the fallback edit.
    const editTextArgs = channel.editMessage.mock.calls.map((call) => call[2] as string);
    expect(editTextArgs).toContain('_(failed to render reply — see logs)_');
  });

  it('I2b (Case A): editMessage returning false does NOT cause an unhandled throw — relay completes gracefully', async () => {
    const session = makeMockSession(['Hello world']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: true, supportsMessageEdit: true });
    channel.editMessage.mockResolvedValue(false);

    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await expect(relayPromise).resolves.toBeUndefined();
  });

  it('I2c (Case C): editMessage returning false triggers fallback in the no-stream path', async () => {
    const session = makeMockSession(['Hello world']);
    const factory = makeMockFactory(session);
    // Case C: supportsStreaming=false, supportsMessageEdit=true
    const channel = makeCapabilityChannel({ supportsStreaming: false, supportsMessageEdit: true });
    channel.editMessage.mockResolvedValue(false);

    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    const editTextArgs = channel.editMessage.mock.calls.map((call) => call[2] as string);
    expect(editTextArgs).toContain('_(failed to render reply — see logs)_');
  });

  it('I2d: editMessage throwing (not returning false) still triggers the error path', async () => {
    // This is the pre-existing behavior; confirm it still works alongside I2.
    const session = makeMockSession(['Hello world']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: true, supportsMessageEdit: true });
    channel.editMessage.mockRejectedValue(new Error('API failure'));

    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await expect(relayPromise).resolves.toBeUndefined();
  });
});
