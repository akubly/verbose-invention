/**
 * Unit tests for AfkStreamRouter — covering the 7 invariants for PR #7:
 *   1. sessionRequestIds empty-Set deletion after last requestId removed (enqueueChunk)
 *   2. sessionRequestIds empty-Set deletion after last requestId removed (enqueueError)
 *   3. handleChunk continues and runs done-cleanup when binding is removed mid-stream
 *   4. handleError deletes streamState even when no topic binding is present
 *   5. handleChunk retries placeholder creation on transient sendMessage failure
 *   6. displayText: non-empty placeholder + 4096-char display cap (cycle 3)
 *   7. handleError isActive guard: state cleaned up, Telegram send skipped when inactive (cycle 3)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AfkStreamRouter, TELEGRAM_MAX_DISPLAY, type AfkStreamRouterDeps } from '../../src/bot/afkStreamRouter.js';

const CHAT_ID = -1001111111111;

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function drain(iterations = 15): Promise<void> {
  for (let i = 0; i < iterations; i++) await flush();
}

function makeRouter(overrides: Partial<AfkStreamRouterDeps> = {}): {
  router: AfkStreamRouter;
  deps: AfkStreamRouterDeps;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  getTopicId: ReturnType<typeof vi.fn>;
} {
  let msgCounter = 100;
  const sendMessage = vi.fn(async () => ({ message_id: ++msgCounter }));
  const editMessageText = vi.fn(async () => true);
  const getTopicId = vi.fn((_sessionId: string): number | undefined => 5001);

  const deps: AfkStreamRouterDeps = {
    getTopicId,
    isActive: () => true,
    chatId: CHAT_ID,
    bot: { api: { sendMessage, editMessageText } } as unknown as AfkStreamRouterDeps['bot'],
    ...overrides,
  };

  return { router: new AfkStreamRouter(deps), deps, sendMessage, editMessageText, getTopicId };
}

describe('AfkStreamRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Thread 1: empty-Set deletion via enqueueChunk ───────────────────────────

  describe('sessionRequestIds cleanup', () => {
    it('T1-chunk — removes sessionId entry when last requestId completes via enqueueChunk', async () => {
      const { router } = makeRouter();
      const sessionId = 'sess-1';

      // Enqueue a single done=true chunk (creates + immediately completes the stream).
      router.enqueueChunk(sessionId, 'req-1', 'hello', true);
      await drain();

      const ids = (router as unknown as { sessionRequestIds: Map<string, Set<string>> }).sessionRequestIds;
      expect(ids.has(sessionId)).toBe(false);
    });

    it('T1-chunk — keeps sessionId entry while at least one requestId is still active', async () => {
      const { router } = makeRouter();
      const sessionId = 'sess-1';

      // Two concurrent requests; only req-1 completes.
      router.enqueueChunk(sessionId, 'req-1', 'chunk', true);
      router.enqueueChunk(sessionId, 'req-2', 'chunk', false);
      await drain();

      const ids = (router as unknown as { sessionRequestIds: Map<string, Set<string>> }).sessionRequestIds;
      expect(ids.has(sessionId)).toBe(true);
      expect(ids.get(sessionId)?.has('req-2')).toBe(true);
    });

    // ─── Thread 2: empty-Set deletion via enqueueError ────────────────────────

    it('T2-error — removes sessionId entry when requestId completes via enqueueError', async () => {
      const { router } = makeRouter();
      const sessionId = 'sess-2';

      router.enqueueError(sessionId, 'req-1', 'something broke');
      await drain();

      const ids = (router as unknown as { sessionRequestIds: Map<string, Set<string>> }).sessionRequestIds;
      expect(ids.has(sessionId)).toBe(false);
    });
  });

  // ─── Thread 3: handleChunk continues when binding removed mid-stream ─────────

  describe('handleChunk mid-stream binding removal', () => {
    it('T3 — done=true cleanup runs even when getTopicId returns undefined mid-stream', async () => {
      const { router, getTopicId, sendMessage } = makeRouter();
      const sessionId = 'sess-3';
      const requestId = 'req-1';

      // First chunk: binding present — creates placeholder and state.
      router.enqueueChunk(sessionId, requestId, 'part one ', false);
      await drain();

      expect(sendMessage).toHaveBeenCalledOnce();

      // Simulate binding removed mid-stream.
      getTopicId.mockReturnValue(undefined);

      // done=true chunk: no current binding, but existing state has topicId — should proceed and clean up.
      router.enqueueChunk(sessionId, requestId, 'part two', true);
      await drain();

      const states = (router as unknown as { streamStates: Map<string, unknown> }).streamStates;
      expect(states.has(`${sessionId}:${requestId}`)).toBe(false);
    });

    it('T3 — editMessageText is called on done=true even with binding removed', async () => {
      const { router, getTopicId, editMessageText } = makeRouter();
      const sessionId = 'sess-3b';
      const requestId = 'req-1';

      router.enqueueChunk(sessionId, requestId, 'initial', false);
      await drain();

      getTopicId.mockReturnValue(undefined);

      router.enqueueChunk(sessionId, requestId, ' final', true);
      await drain();

      expect(editMessageText).toHaveBeenCalled();
      expect(editMessageText.mock.calls.at(-1)?.[2]).toContain('final');
    });
  });

  // ─── Thread 4: handleError deletes state even with no binding ────────────────

  describe('handleError state cleanup without binding', () => {
    it('T4 — streamStates entry is deleted even when getTopicId returns undefined', async () => {
      const { router, getTopicId } = makeRouter();
      const sessionId = 'sess-4';
      const requestId = 'req-1';

      // Create state via a non-done chunk while binding is present.
      router.enqueueChunk(sessionId, requestId, 'work in progress', false);
      await drain();

      const states = (router as unknown as { streamStates: Map<string, unknown> }).streamStates;
      expect(states.has(`${sessionId}:${requestId}`)).toBe(true);

      // Remove binding.
      getTopicId.mockReturnValue(undefined);

      // Error terminates the stream; state must be deleted regardless of binding.
      router.enqueueError(sessionId, requestId, 'tool crashed');
      await drain();

      expect(states.has(`${sessionId}:${requestId}`)).toBe(false);
    });

    it('T4 — editMessageText is called with error text when state has a messageId (topicId from state)', async () => {
      const { router, getTopicId, editMessageText } = makeRouter();
      const sessionId = 'sess-4b';
      const requestId = 'req-1';

      router.enqueueChunk(sessionId, requestId, 'partial output', false);
      await drain();

      // Remove binding — state still holds topicId from when it was created.
      getTopicId.mockReturnValue(undefined);

      router.enqueueError(sessionId, requestId, 'unexpected failure');
      await drain();

      expect(editMessageText).toHaveBeenCalledWith(
        CHAT_ID,
        expect.any(Number),
        '❌ Error: unexpected failure',
      );
    });

    it('T4 — no Telegram call and no throw when neither state nor binding exists', async () => {
      const { router, getTopicId, sendMessage, editMessageText } = makeRouter();
      getTopicId.mockReturnValue(undefined);

      // enqueueError with no prior state and no binding — must complete cleanly.
      router.enqueueError('sess-4c', 'req-orphan', 'orphan error');
      await drain();

      expect(sendMessage).not.toHaveBeenCalled();
      expect(editMessageText).not.toHaveBeenCalled();
    });
  });

  // ─── Thread 5: placeholder retry on transient sendMessage failure ─────────────

  describe('handleChunk placeholder retry on transient sendMessage failure', () => {
    it('T5a — sendMessage throw preserves buffer and leaves messageId undefined', async () => {
      const { router, sendMessage } = makeRouter();
      const sessionId = 'sess-5';
      const requestId = 'req-1';

      sendMessage.mockRejectedValueOnce(new Error('rate limited'));

      router.enqueueChunk(sessionId, requestId, 'chunk one', false);
      await drain();

      const states = (router as unknown as { streamStates: Map<string, { messageId?: number; text: string }> }).streamStates;
      const state = states.get(`${sessionId}:${requestId}`);
      expect(state).toBeDefined();
      expect(state!.messageId).toBeUndefined();
      expect(state!.text).toBe('chunk one');
    });

    it('T5b — second chunk retries sendMessage with the full cumulative buffer', async () => {
      const { router, sendMessage } = makeRouter();
      const sessionId = 'sess-5';
      const requestId = 'req-1';

      sendMessage.mockRejectedValueOnce(new Error('rate limited'));

      router.enqueueChunk(sessionId, requestId, 'chunk one', false);
      await drain();

      // Default mock now succeeds.
      router.enqueueChunk(sessionId, requestId, ' chunk two', false);
      await drain();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      // Second call must carry the full accumulated buffer (chunk1 + chunk2).
      expect(sendMessage.mock.calls.at(-1)?.[1]).toBe('chunk one chunk two');

      const states = (router as unknown as { streamStates: Map<string, { messageId?: number }> }).streamStates;
      expect(states.get(`${sessionId}:${requestId}`)!.messageId).toBeDefined();
    });

    it('T5c — third chunk uses throttled-edit path; no additional sendMessage calls', async () => {
      const { router, sendMessage, editMessageText } = makeRouter();
      const sessionId = 'sess-5';
      const requestId = 'req-1';

      sendMessage.mockRejectedValueOnce(new Error('rate limited'));

      router.enqueueChunk(sessionId, requestId, 'chunk one', false);
      await drain();

      router.enqueueChunk(sessionId, requestId, ' chunk two', false);
      await drain();

      // Advance time past the 800ms throttle so the next non-done chunk would edit.
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));

      router.enqueueChunk(sessionId, requestId, ' chunk three', true);
      await drain();

      // No further sendMessage — placeholder was already created on chunk 2.
      expect(sendMessage).toHaveBeenCalledTimes(2);
      // editMessageText called with the full accumulated content.
      expect(editMessageText).toHaveBeenCalledWith(
        CHAT_ID,
        expect.any(Number),
        'chunk one chunk two chunk three',
      );
    });
  });

  // ─── Thread A (cycle 3): 4096-char display cap + non-empty placeholder ────────

  describe('displayText: 4096-char cap and non-empty placeholder', () => {
    it('TA1 — sendMessage called with "…" when first chunk is an empty string', async () => {
      const { router, sendMessage } = makeRouter();

      router.enqueueChunk('sess-a1', 'req-1', '', false);
      await drain();

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][1]).toBe('…');
    });

    it('TA2 — editMessageText display string is ≤ TELEGRAM_MAX_DISPLAY when buffer exceeds the cap', async () => {
      const { router, editMessageText } = makeRouter();
      const sessionId = 'sess-a2';
      const requestId = 'req-1';

      // First chunk: creates the placeholder.
      router.enqueueChunk(sessionId, requestId, 'seed', false);
      await drain();

      // Advance past throttle and send a very long chunk.
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      router.enqueueChunk(sessionId, requestId, 'b'.repeat(5000), false);
      await drain();

      const displayed = editMessageText.mock.calls.at(-1)?.[2] as string;
      expect(displayed.length).toBeLessThanOrEqual(TELEGRAM_MAX_DISPLAY);
    });

    it('TA3 — truncated display shows truncation prefix + last N chars of the full buffer', async () => {
      const { router, editMessageText } = makeRouter();
      const sessionId = 'sess-a3';
      const requestId = 'req-1';

      router.enqueueChunk(sessionId, requestId, 'seed', false);
      await drain();

      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      const longChunk = 'c'.repeat(5000);
      router.enqueueChunk(sessionId, requestId, longChunk, false);
      await drain();

      const displayed = editMessageText.mock.calls.at(-1)?.[2] as string;
      const TRUNCATION_PREFIX = '…(truncated)\n';
      const expectedBody = ('seed' + longChunk).slice(-(TELEGRAM_MAX_DISPLAY - TRUNCATION_PREFIX.length));
      expect(displayed).toBe(TRUNCATION_PREFIX + expectedBody);
    });
  });

  // ─── Thread B (cycle 3): handleError isActive guard ──────────────────────────

  describe('handleError isActive guard', () => {
    it('TB1 — state cleaned up but no Telegram send when isActive returns false', async () => {
      const isActive = vi.fn(() => true as boolean);
      const { router, sendMessage, editMessageText } = makeRouter({ isActive });
      const sessionId = 'sess-b1';
      const requestId = 'req-1';

      // Create placeholder (isActive = true).
      router.enqueueChunk(sessionId, requestId, 'partial', false);
      await drain();
      expect(sendMessage).toHaveBeenCalledOnce(); // sanity: placeholder created

      // Deactivate before the error arrives.
      isActive.mockReturnValue(false);

      router.enqueueError(sessionId, requestId, 'some error');
      await drain();

      // State MUST be deleted (cycle-1 invariant).
      const states = (router as unknown as { streamStates: Map<string, unknown> }).streamStates;
      expect(states.has(`${sessionId}:${requestId}`)).toBe(false);
      // No additional Telegram calls — the error edit must be suppressed.
      expect(editMessageText).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce(); // still only the placeholder
    });

    it('TB2 — error emission fires normally when isActive returns true (regression guard)', async () => {
      const { router, editMessageText } = makeRouter();
      const sessionId = 'sess-b2';
      const requestId = 'req-1';

      router.enqueueChunk(sessionId, requestId, 'partial', false);
      await drain();

      router.enqueueError(sessionId, requestId, 'tool crashed');
      await drain();

      expect(editMessageText).toHaveBeenCalledWith(
        CHAT_ID,
        expect.any(Number),
        '❌ Error: tool crashed',
      );
    });
  });
});
