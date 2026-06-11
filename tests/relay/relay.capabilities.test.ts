/**
 * relay.capabilities.test.ts — F1 independent verification
 *
 * These tests drive the REAL relay against mock channels with each capability
 * combination and assert Carter's exact spec from
 * .squad/decisions/inbox/carter-f1-relay-capability-fix.md.
 *
 * They would FAIL on the pre-fix relay (commit before e1f3f4d) and PASS on
 * the fixed three-case branch.  Each case is self-contained — no shared state
 * between groups.
 *
 * Case B  supportsMessageEdit:false  — accumulate silently, one sendMessage
 * Case C  supportsStreaming:false, supportsMessageEdit:true — "thinking…" + one editMessage
 * Case A  supportsStreaming:true,  supportsMessageEdit:true — regression guard (Telegram path)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { SessionEntry } from '../../src/sessions/registry.js';
import type { ChannelPort, ChannelCapabilities, ChannelContext } from '../../src/channel/port.js';
import { makeMockFactory, makeMockSession } from '../mocks/sdk.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Mirrors makeMockChannel() from relay.test.ts — reproduced here so the
 *  capability file is self-contained without cross-test imports. */
function makeMockChannel(): ChannelPort & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue({ id: '100' });
  const editMessage = vi.fn().mockResolvedValue(true);
  return {
    name: 'mock',
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage,
    editMessage,
    splitMessage: vi.fn((text: string, footer?: string) => {
      const full = footer ? `${text}\n\n${footer}` : text;
      return [full];
    }),
    formatForTransport: vi.fn((text: string) => text),
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
  };
}

/**
 * Returns a mock channel with the given capability flags overriding defaults.
 * Pattern from Carter's spec (FakeChannel helper section).
 */
function makeCapabilityChannel(overrides: Partial<ChannelCapabilities>): ChannelPort & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
} {
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

// ─── Case B — supportsMessageEdit:false ───────────────────────────────────────

describe('Relay capability: Case B — supportsMessageEdit:false', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never calls editMessage on a normal response', async () => {
    const session = makeMockSession(['The', ' full', ' answer.']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsMessageEdit: false });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.editMessage).not.toHaveBeenCalled();
  });

  it('calls sendMessage exactly once with the full assembled response', async () => {
    const session = makeMockSession(['The', ' full', ' answer.']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsMessageEdit: false });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    const arg = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(arg).toContain('The full answer.');
  });

  it('does not send the "…" or "thinking…" placeholder — single sendMessage is the final response', async () => {
    const session = makeMockSession(['Real', ' response', ' here.']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsMessageEdit: false });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    const arg = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(arg).not.toBe('…');
    expect(arg).not.toBe('thinking…');
    expect(arg).toContain('Real response here.');
  });

  it('error path: editMessage is never called; sendMessage called once with "❌ Error:" text', async () => {
    // failAfter:0 → throws before yielding any chunk
    const session = makeMockSession(['partial'], 0);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsMessageEdit: false });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.editMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    const arg = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(arg).toMatch(/^❌ Error:/);
  });
});

// ─── Case C — supportsStreaming:false, supportsMessageEdit:true ───────────────

describe('Relay capability: Case C — supportsStreaming:false, supportsMessageEdit:true', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('first sendMessage arg is "thinking…"', async () => {
    const session = makeMockSession(['Full response text.']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: false, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.sendMessage).toHaveBeenNthCalledWith(1, DEFAULT_CTX, 'thinking…');
  });

  it('editMessage called exactly once — the single final replacement', async () => {
    const session = makeMockSession(['Full response text.']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: false, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    const editArg = (channel.editMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(editArg).toContain('Full response text.');
  });

  /**
   * THE critical anti-regression for F1.
   *
   * Pre-fix relay (before e1f3f4d): for any channel, the relay sent "…" as
   * the placeholder and ran the full Case A loop — calling editMessage once
   * per 800ms window.  If fake timers are advanced so the throttle fires on
   * every chunk, editMessage call count grows proportionally with chunk count.
   *
   * Fixed relay (Case C branch): stream chunks are accumulated WITHOUT any
   * intermediate edits.  editMessage is called exactly once (the final
   * replacement), regardless of how many chunks the session emits.
   *
   * We emit 12 chunks and advance fake time by 1000ms (> throttle) between
   * each chunk so that the pre-fix throttle WOULD fire on each one.
   * On the fixed code the loop has no editMessage calls at all, so the count
   * stays 1 (only the unconditional final edit).
   */
  it('editMessage count is exactly 1 even with 12 stream chunks and throttle-advancing timers (anti-regression for F1)', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });

    // Start fake clock well above zero so 0 - lastEditAt check would fire.
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    // Build a session whose iterator advances fake time by 1 second per chunk
    // so the 800ms throttle would trip on every iteration in the pre-fix code.
    const CHUNKS = Array.from({ length: 12 }, (_, i) => `chunk${i + 1} `);
    let chunkIndex = 0;
    const timerAdvancingSession = {
      send: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of CHUNKS) {
            yield chunk;
            chunkIndex++;
            // Advance fake clock by 1000ms — forces throttle to fire on
            // every chunk iteration in the pre-fix Case A path.
            vi.advanceTimersByTime(1000);
          }
        },
      }),
    };

    const factory = makeMockFactory(timerAdvancingSession);
    const channel = makeCapabilityChannel({ supportsStreaming: false, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    // Must be exactly 1 — not proportional to the 12 chunks.
    expect(channel.editMessage).toHaveBeenCalledTimes(1);

    const editArg = (channel.editMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    // All 12 chunks must be present in the single final edit (full accumulation).
    for (let i = 1; i <= 12; i++) {
      expect(editArg).toContain(`chunk${i} `);
    }

    // Confirm all 12 chunks were actually iterated.
    expect(chunkIndex).toBe(12);
  });

  it('error path: sendMessage called once ("thinking…") then editMessage called once with error text', async () => {
    // failAfter:0 → throws before yielding any chunk
    const session = makeMockSession(['partial'], 0);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: false, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    await relay.relay(DEFAULT_CTX, DEFAULT_TEXT);

    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(DEFAULT_CTX, 'thinking…');
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    const editArg = (channel.editMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(editArg).toMatch(/^❌ Error:/);
  });
});

// ─── Case A — regression guard (Telegram path) ────────────────────────────────

describe('Relay capability: Case A — supportsStreaming:true, supportsMessageEdit:true (regression guard)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends "…" placeholder and edits with final assembled response (Telegram path unchanged)', async () => {
    const session = makeMockSession(['Hello', ' world']);
    const factory = makeMockFactory(session);
    const channel = makeCapabilityChannel({ supportsStreaming: true, supportsMessageEdit: true });
    const relay = new Relay(channel, makeStubRegistry([SESSION_ENTRY]), factory, 'test-model');

    const relayPromise = relay.relay(DEFAULT_CTX, DEFAULT_TEXT);
    await vi.runAllTimersAsync();
    await relayPromise;

    // Placeholder must be "…" (not "thinking…")
    expect(channel.sendMessage).toHaveBeenCalledWith(DEFAULT_CTX, '…');

    // At least one edit must have occurred — the final unconditional one.
    const editCalls = (channel.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(editCalls.length).toBeGreaterThan(0);
    const finalArg = editCalls[editCalls.length - 1][2] as string;
    expect(finalArg).toContain('Hello world');
  });
});
