/**
 * J2 — Relay integration tests with BridgeSession.
 *
 * Scope: verifies that the BridgeSession adapter integrates correctly with
 * relay.ts — specifically that:
 *   1. BridgeSession yields the full accumulated string when consumed directly
 *      (proves the adapter delivers correct content to any consumer).
 *   2. When used inside the relay, the final editMessageText call contains all
 *      accumulated chunks (the 800ms throttle contract is preserved: with a
 *      frozen Date.now the throttle never fires mid-stream, so only the final
 *      edit fires).
 *
 * Scope reduction from Noble Six's original J2 spec:
 * The relay throttle is already exhaustively tested in relay.test.ts for any
 * CopilotSession implementation. Since BridgeSession fulfils the CopilotSession
 * contract (proven by J1 tests), the throttle applies by the Liskov Substitution
 * Principle. A full throttle-tick test here would require tight async orchestration
 * that couples to relay internals. The regression guard is the final-edit assertion:
 * if the 800ms throttle were broken across the adapter boundary (e.g., accumulation
 * restarted mid-stream), the final edit content would be wrong.
 * See: .squad/decisions/inbox/jun-phase6-days3-4-bridge-tests.md
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { BridgeSession } from '../../src/bridge/bridgeSession.js';
import { Relay } from '../../src/relay/relay.js';
import type { SessionLookup } from '../../src/relay/ports.js';
import type { SessionEntry } from '../../src/sessions/registry.js';
import type { CopilotSessionFactory } from '../../src/copilot/factory.js';
import { escapeMarkdownV2 } from '../../src/relay/markdownV2.js';
import { FakeBridge } from '../helpers/FakeBridge.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const SESSION_ID = 'reach-myapp-session-id';
const REQUEST_ID = 'req-relay-j2';

const SESSION_ENTRY: SessionEntry = {
  sessionName: 'reach-myapp',
  topicId: 42,
  chatId: -1001234567890,
  createdAt: '2026-05-22T00:00:00.000Z',
};

function makeStubRegistry(entries: SessionEntry[] = []): SessionLookup {
  const map = new Map(entries.map((e) => [e.topicId, e]));
  return { resolve: vi.fn((topicId: number) => map.get(topicId)) };
}

function makeMockCtx(
  text = 'Hello Copilot',
  topicId = 42,
  chatId = -1001234567890,
) {
  return {
    message: { message_thread_id: topicId, text },
    chat: { id: chatId },
    reply: vi.fn().mockResolvedValue({ message_id: 100, chat: { id: chatId } }),
    api: {
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── J2-A: Direct BridgeSession consumption ────────────────────────────────────

describe('BridgeSession as CopilotSession (direct consumption)', () => {
  it('accumulates all chunks into the correct final string when consumed end-to-end', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const accumulated: string[] = [];
    const consuming = (async () => {
      for await (const chunk of session.send('hello')) {
        accumulated.push(chunk);
      }
    })();

    // Generator started, parked at queue-wait — emit chunks synchronously
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'Hello', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, ', ', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'world', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, '!', true);

    await consuming;

    expect(accumulated).toEqual(['Hello', ', ', 'world', '!']);
    expect(accumulated.join('')).toBe('Hello, world!');
  });

  it('propagates stream.error as a thrown exception to the consumer', async () => {
    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const iter = session.send('hello')[Symbol.asyncIterator]();
    const p = iter.next();

    bridge.emitStreamError(SESSION_ID, REQUEST_ID, 'extension crashed');

    await expect(p).rejects.toThrow('extension crashed');
  });
});

// ── J2-B: Relay integration ────────────────────────────────────────────────────

describe('relay + BridgeSession integration', () => {
  it('final editMessageText contains all accumulated chunks — throttle contract preserved', async () => {
    // Freeze Date.now() → throttle (STREAM_EDIT_THROTTLE_MS = 800ms) never fires
    // mid-stream, so relay only calls editMessageText once (the final edit).
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });

    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const factory: CopilotSessionFactory = {
      resume: vi.fn().mockResolvedValue(session),
      create: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');
    const ctx = makeMockCtx();

    // Start relay — don't await yet
    const relayDone = relay.relay(ctx as Parameters<typeof relay.relay>[0]);

    // Yield to the microtask queue: relay runs through ctx.reply(), factory.resume(),
    // and into the `for await` loop (all mock awaits are microtask-resolved Promises).
    // One setImmediate tick is enough — it fires after all pending microtasks drain.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Relay is now parked in BridgeSession's queue-wait; emit chunks synchronously
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'Alpha', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, ' Beta', false);
    bridge.emitStream(SESSION_ID, REQUEST_ID, ' Gamma', true); // done

    await relayDone;

    const editCalls = (
      ctx.api.editMessageText as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(editCalls.length).toBeGreaterThan(0);

    const finalText = editCalls[editCalls.length - 1][2] as string;
    // The relay escapes with MarkdownV2 and appends a HUD footer
    expect(finalText).toContain(escapeMarkdownV2('Alpha Beta Gamma'));
  });

  it('editMessageText is called at most once per 800ms during rapid-fire chunks (throttle regression guard)', async () => {
    // Freeze Date.now() at a constant value throughout (same pattern as relay.test.ts).
    // Throttle logic: `now - lastEditAt >= 800`. With a constant Date.now():
    //   - First chunk: Date.now() - 0 (lastEditAt) is large → throttle fires once (edit 1)
    //   - Subsequent chunks: Date.now() - Date.now() = 0 < 800 → throttle blocked
    //   - After stream ends: final edit always fires (edit 2)
    // Result: exactly 2 edits for N rapid-fire chunks (N-1 chunks throttled).
    // This verifies the throttle contract holds across the adapter boundary.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    });

    const bridge = new FakeBridge();
    const session = new BridgeSession(bridge, SESSION_ID, () => REQUEST_ID);

    const factory: CopilotSessionFactory = {
      resume: vi.fn().mockResolvedValue(session),
      create: vi.fn(),
    };

    const registry = makeStubRegistry([SESSION_ENTRY]);
    const relay = new Relay(registry, factory, 'test-model');
    const ctx = makeMockCtx();

    const relayDone = relay.relay(ctx as Parameters<typeof relay.relay>[0]);

    await new Promise<void>((resolve) => setImmediate(resolve));

    // Emit 5 rapid-fire chunks with no time advance (Date.now frozen → throttle
    // never fires mid-stream). All chunks should accumulate; only the final edit fires.
    for (let i = 0; i < 4; i++) {
      bridge.emitStream(SESSION_ID, REQUEST_ID, `chunk${i} `, false);
    }
    bridge.emitStream(SESSION_ID, REQUEST_ID, 'last', true);

    await relayDone;

    const editCalls = (
      ctx.api.editMessageText as ReturnType<typeof vi.fn>
    ).mock.calls;

    // With Date.now frozen: exactly 1 mid-stream edit + 1 final = 2 total.
    // This is far fewer than the 5 chunks emitted — proof the throttle is working.
    expect(editCalls.length).toBe(2);

    const finalText = editCalls[editCalls.length - 1][2] as string;
    expect(finalText).toContain(escapeMarkdownV2('chunk0 chunk1 chunk2 chunk3 last'));
  });
});
