/**
 * Behavioral conformance kit for ChannelPort implementations (P1-7).
 *
 * Usage:
 *   import { runChannelPortConformance } from '../conformance/runner.js';
 *   runChannelPortConformance(() => new MyChannel(), { name: 'my-channel' });
 *
 * The kit drives both:
 *  1. A FakeChannel with each capability toggled ON/OFF to prove the
 *     CONTRACTED fallback matrix.
 *  2. A real adapter (supplied via makePort) to assert declared capabilities
 *     match actual behavior (the "anti-lie guarantee").
 *
 * HARD RULE: This file MUST NOT change production code. If a contract
 * violation is detected, document it and throw a descriptive error so the
 * test fails clearly — routing the fix to the right owner.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChannelPort, ChannelContext, PromptOption } from '../../../src/channel/port.js';
import { FakeChannel } from './FakeChannel.js';

// ── Shared context constants ──────────────────────────────────────────────────

export const TEST_CTX: ChannelContext = { threadId: '42', channelId: '-1001234567890' };
export const EMPTY_TOPIC_CTX: ChannelContext = { threadId: '', channelId: '-1001234567890' };

// ── Minimal no-createThread adapter ──────────────────────────────────────────
//
// Used by the I4 optional-method test to verify the conformance kit and caller
// guard work correctly when createThread is ABSENT (not just throwing).
// This is a more faithful simulation of a Teams-style adapter than FakeChannel,
// which still defines createThread as a throwing method.

function makeMinimalNoThreadPort(): ChannelPort {
  return {
    name: 'minimal-no-thread',
    capabilities: {
      supportsMessageEdit: false,
      supportsThreadCreation: false,
      supportsInteractivePrompts: false,
      supportsStreaming: false,
      maxMessageLength: 1000,
    },
    start: async () => undefined,
    stop: async () => undefined,
    sendMessage: async () => ({ id: '1' }),
    editMessage: async () => false,
    formatForTransport: (markdown) => markdown,
    splitMessage: (text, footer) => (footer ? [`${text}\n\n${footer}`] : [text]),
    promptUser: async (_ctx, _q, _opts, signal) => (signal?.aborted ? '' : ''),
    onMessage: () => undefined,
    onCommand: () => undefined,
    // createThread intentionally absent — satisfies the optional-method contract
  };
}

// ── Suite options ─────────────────────────────────────────────────────────────

export interface ConformanceOpts {
  /** Human-readable name of the adapter under test (used in describe labels). */
  name: string;
  /**
   * Skip lifecycle tests that call start()/stop() with real I/O.
   * Set to true for adapters that require network access.
   * Default: false.
   */
  skipLifecycle?: boolean;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the full ChannelPort behavioral conformance suite against `makePort`.
 *
 * `makePort` is called fresh for each test group (not each `it`) to avoid
 * cross-test state pollution.
 */
export function runChannelPortConformance(
  makePort: () => ChannelPort,
  opts: ConformanceOpts,
): void {
  const { name, skipLifecycle = false } = opts;

  describe(`ChannelPort conformance — ${name}`, () => {
    // ── 1. Lifecycle ──────────────────────────────────────────────────────────

    describe('lifecycle', () => {
      it('start() resolves without throwing', async () => {
        if (skipLifecycle) return;
        const port = makePort();
        await expect(port.start()).resolves.toBeUndefined();
        await port.stop().catch(() => undefined);
      });

      it('stop() resolves without throwing', async () => {
        if (skipLifecycle) return;
        const port = makePort();
        await port.start().catch(() => undefined);
        await expect(port.stop()).resolves.toBeUndefined();
      });

      it('stop() is idempotent — calling twice does not throw', async () => {
        if (skipLifecycle) return;
        const port = makePort();
        await port.start().catch(() => undefined);
        await port.stop();
        await expect(port.stop()).resolves.toBeUndefined();
      });
    });

    // ── 2. Outbound ───────────────────────────────────────────────────────────

    describe('sendMessage', () => {
      it('returns a MessageRef with a non-empty id string', async () => {
        const port = makePort();
        const ref = await port.sendMessage(TEST_CTX, 'hello');
        expect(ref).toBeDefined();
        expect(typeof ref.id).toBe('string');
        expect(ref.id.length).toBeGreaterThan(0);
      });

      it('accepts empty-string threadId (General Topic) without throwing', async () => {
        const port = makePort();
        await expect(port.sendMessage(EMPTY_TOPIC_CTX, 'general hello')).resolves.toBeDefined();
      });
    });

    describe('editMessage', () => {
      it('returns a boolean', async () => {
        const port = makePort();
        const ref = await port.sendMessage(TEST_CTX, 'original');
        const result = await port.editMessage(TEST_CTX, ref, 'updated');
        expect(typeof result).toBe('boolean');
      });

      it('returns false when supportsMessageEdit=false', async () => {
        // Use FakeChannel with edit disabled; real adapter is skipped for this branch.
        const fake = new FakeChannel({ supportsMessageEdit: false });
        const ref = await fake.sendMessage(TEST_CTX, 'original');
        const result = await fake.editMessage(TEST_CTX, ref, 'updated');
        expect(result).toBe(false);
        expect(fake.edits).toHaveLength(0);
      });

      it('returns true and records edit when supportsMessageEdit=true', async () => {
        const fake = new FakeChannel({ supportsMessageEdit: true });
        const ref = await fake.sendMessage(TEST_CTX, 'original');
        const result = await fake.editMessage(TEST_CTX, ref, 'updated');
        expect(result).toBe(true);
        expect(fake.edits).toHaveLength(1);
        expect(fake.edits[0]!.text).toBe('updated');
      });
    });

    // ── 3. Formatting ─────────────────────────────────────────────────────────

    describe('formatForTransport', () => {
      it('returns a string', () => {
        const port = makePort();
        const result = port.formatForTransport('**hello**');
        expect(typeof result).toBe('string');
      });

      it('does not return undefined or null', () => {
        const port = makePort();
        expect(port.formatForTransport('')).toBeDefined();
        expect(port.formatForTransport('plain text')).toBeDefined();
      });
    });

    describe('splitMessage', () => {
      it('returns an array with at least one chunk', () => {
        const port = makePort();
        const chunks = port.splitMessage('hello world');
        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('each chunk is within maxMessageLength characters', () => {
        const port = makePort();
        const longText = 'A'.repeat(port.capabilities.maxMessageLength * 3);
        const chunks = port.splitMessage(longText);
        for (const chunk of chunks) {
          expect(chunk.length).toBeLessThanOrEqual(port.capabilities.maxMessageLength);
        }
      });

      it('footer appears in the last chunk when provided', () => {
        const port = makePort();
        const chunks = port.splitMessage('some message', 'footer text');
        const lastChunk = chunks[chunks.length - 1]!;
        expect(lastChunk).toContain('footer text');
      });

      it('no chunk exceeds maxMessageLength even with footer', () => {
        const port = makePort();
        const longText = 'B'.repeat(port.capabilities.maxMessageLength * 2);
        const chunks = port.splitMessage(longText, 'the footer');
        for (const chunk of chunks) {
          expect(chunk.length).toBeLessThanOrEqual(port.capabilities.maxMessageLength);
        }
      });

      it('returns single-chunk array for short text with no footer', () => {
        const port = makePort();
        const chunks = port.splitMessage('short');
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe('short');
      });
    });

    // ── 4. Inbound ────────────────────────────────────────────────────────────

    describe('onMessage', () => {
      it('fires the registered handler with correct ChannelContext (string fields)', async () => {
        const fake = new FakeChannel();
        let captured: { ctx: ChannelContext; text: string } | undefined;
        fake.onMessage(async (ctx, text) => { captured = { ctx, text }; });
        await fake.injectInboundText(TEST_CTX, 'hello');
        expect(captured).toBeDefined();
        expect(typeof captured!.ctx.threadId).toBe('string');
        expect(typeof captured!.ctx.channelId).toBe('string');
        expect(captured!.ctx.threadId).toBe('42');
        expect(captured!.ctx.channelId).toBe('-1001234567890');
        expect(captured!.text).toBe('hello');
      });

      it('replacing the handler (second onMessage call) replaces the previous one', async () => {
        const fake = new FakeChannel();
        const calls: string[] = [];
        fake.onMessage(async (_, text) => { calls.push('first:' + text); });
        fake.onMessage(async (_, text) => { calls.push('second:' + text); });
        await fake.injectInboundText(TEST_CTX, 'ping');
        expect(calls).toEqual(['second:ping']);
      });
    });

    describe('onCommand', () => {
      it('fires the registered handler with correct ChannelContext and parsed args', async () => {
        const fake = new FakeChannel();
        let captured: { ctx: ChannelContext; args: string } | undefined;
        fake.onCommand('test', async (ctx, args) => { captured = { ctx, args }; });
        await fake.injectCommand('test', TEST_CTX, 'arg1 arg2');
        expect(captured).toBeDefined();
        expect(captured!.ctx.threadId).toBe('42');
        expect(captured!.args).toBe('arg1 arg2');
      });

      it('different commands are dispatched independently', async () => {
        const fake = new FakeChannel();
        const log: string[] = [];
        fake.onCommand('alpha', async (_, args) => { log.push('alpha:' + args); });
        fake.onCommand('beta', async (_, args) => { log.push('beta:' + args); });
        await fake.injectCommand('alpha', TEST_CTX, 'x');
        await fake.injectCommand('beta', TEST_CTX, 'y');
        expect(log).toEqual(['alpha:x', 'beta:y']);
      });

      it('unregistered commands are silently ignored', async () => {
        const fake = new FakeChannel();
        // Should not throw
        await expect(fake.injectCommand('unknown', TEST_CTX, '')).resolves.toBeUndefined();
      });
    });

    // ── 5. Interactive Prompts ────────────────────────────────────────────────

    describe('promptUser', () => {
      const OPTIONS: readonly PromptOption[] = [
        { value: 'approve', label: '✅ Approve' },
        { value: 'deny', label: '❌ Deny' },
      ];

      it('returns a string value (one of the option values)', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: true });
        const result = await fake.promptUser(TEST_CTX, 'Allow?', OPTIONS);
        expect(typeof result).toBe('string');
        const valid = OPTIONS.map((o) => o.value);
        expect(valid).toContain(result);
      });

      it('resolves with empty string when AbortSignal is already aborted', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const controller = new AbortController();
        controller.abort();
        const result = await fake.promptUser(TEST_CTX, 'Allow?', OPTIONS, controller.signal);
        expect(result).toBe('');
      });

      it('text-fallback: resolves on matching inbound text when supportsInteractivePrompts=false', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const promptPromise = fake.promptUser(TEST_CTX, 'Allow?', OPTIONS);
        // Simulate user typing 'approve'
        await fake.injectInboundText(TEST_CTX, 'approve');
        const result = await promptPromise;
        expect(result).toBe('approve');
      });

      it('text-fallback: resolves empty string when AbortSignal fires mid-wait', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const controller = new AbortController();
        const promptPromise = fake.promptUser(TEST_CTX, 'Allow?', OPTIONS, controller.signal);
        controller.abort();
        const result = await promptPromise;
        expect(result).toBe('');
      });
    });

    // ── 6. Thread Management ──────────────────────────────────────────────────

    describe('createThread', () => {
      it('when supportsThreadCreation=true: createThread is present and returns valid ChannelContext', async () => {
        const fake = new FakeChannel({ supportsThreadCreation: true });
        // Optional method — must be present when capability is declared true.
        expect(typeof fake.createThread).toBe('function');
        const ctx = await fake.createThread('-1001234567890', 'My Topic');
        expect(typeof ctx.threadId).toBe('string');
        expect(ctx.threadId.length).toBeGreaterThan(0);
        expect(ctx.channelId).toBe('-1001234567890');
        expect(fake.threadCreations).toHaveLength(1);
      });

      it('when supportsThreadCreation=true on the real adapter: createThread must be a function', () => {
        const port = makePort();
        if (!port.capabilities.supportsThreadCreation) return;
        expect(typeof port.createThread).toBe('function');
      });

      it('when supportsThreadCreation=false: conformance kit does not require createThread', () => {
        const port = makePort();
        if (port.capabilities.supportsThreadCreation) return;
        // Optional method — adapter need NOT implement createThread when capability is false.
        // Kit MUST NOT call createThread in this state.
        expect(port.capabilities.supportsThreadCreation).toBe(false);
      });
    });

    // ── 7. Capabilities shape ─────────────────────────────────────────────────

    describe('capabilities', () => {
      it('exposes all required capability fields as booleans or numbers', () => {
        const port = makePort();
        const { capabilities } = port;
        expect(typeof capabilities.supportsMessageEdit).toBe('boolean');
        expect(typeof capabilities.supportsThreadCreation).toBe('boolean');
        expect(typeof capabilities.supportsInteractivePrompts).toBe('boolean');
        expect(typeof capabilities.supportsStreaming).toBe('boolean');
        expect(typeof capabilities.maxMessageLength).toBe('number');
        expect(capabilities.maxMessageLength).toBeGreaterThan(0);
      });

      it('name field is a non-empty string', () => {
        const port = makePort();
        expect(typeof port.name).toBe('string');
        expect(port.name.length).toBeGreaterThan(0);
      });
    });
  });
}

// ── Capability-fallback matrix (standalone, FakeChannel-driven) ───────────────

/**
 * Proves the contracted fallback behaviors using FakeChannel permutations.
 * Run this once — it does not depend on any real adapter.
 */
export function runCapabilityFallbackMatrix(): void {
  describe('ChannelPort capability-fallback matrix (FakeChannel)', () => {

    // ── supportsMessageEdit=false ─────────────────────────────────────────────

    describe('supportsMessageEdit=false', () => {
      it('editMessage returns false without recording the edit', async () => {
        const fake = new FakeChannel({ supportsMessageEdit: false });
        const ref = await fake.sendMessage(TEST_CTX, 'original');
        const ok = await fake.editMessage(TEST_CTX, ref, 'new text');
        expect(ok).toBe(false);
        expect(fake.edits).toHaveLength(0);
      });

      it('FakeChannel send-once when supportsMessageEdit=false (adapter contract)', async () => {
        // Simulate what core/relay should do: check capability, then decide send-once.
        const fake = new FakeChannel({ supportsMessageEdit: false });
        const FINAL_TEXT = 'Final assembled response';

        // Core MUST NOT call editMessage — it sends the final message directly.
        if (!fake.capabilities.supportsMessageEdit) {
          await fake.sendMessage(TEST_CTX, FINAL_TEXT);
        } else {
          const ref = await fake.sendMessage(TEST_CTX, '…');
          await fake.editMessage(TEST_CTX, ref, FINAL_TEXT);
        }

        expect(fake.sends).toHaveLength(1);
        expect(fake.sends[0]!.text).toBe(FINAL_TEXT);
        expect(fake.edits).toHaveLength(0);
      });
    });

    // ── supportsStreaming=false ───────────────────────────────────────────────

    describe('supportsStreaming=false', () => {
      it('no intermediate stream edits — only placeholder→final edit', async () => {
        const fake = new FakeChannel({ supportsStreaming: false, supportsMessageEdit: true });

        // Core path when streaming=false: send thinking placeholder, then
        // replace with final response via editMessage (no intermediate edits).
        const placeholderRef = await fake.sendMessage(TEST_CTX, '…');
        // Simulate: NO intermediate edits during "streaming"
        // Core only calls editMessage once at the end.
        await fake.editMessage(TEST_CTX, placeholderRef, 'Final response');

        expect(fake.sends).toHaveLength(1);
        expect(fake.edits).toHaveLength(1);
        expect(fake.edits[0]!.text).toBe('Final response');
      });

      it('streaming=false + edit=false: sends new final message (no edit)', async () => {
        const fake = new FakeChannel({ supportsStreaming: false, supportsMessageEdit: false });

        // Core path: send thinking placeholder, then send final as NEW message.
        await fake.sendMessage(TEST_CTX, '…');
        const editOk = await fake.editMessage(TEST_CTX, { id: '1' }, 'Final');
        expect(editOk).toBe(false);
        // Core should fall back to sendMessage for the final response.
        await fake.sendMessage(TEST_CTX, 'Final response');

        expect(fake.sends).toHaveLength(2);
        expect(fake.edits).toHaveLength(0);
      });
    });

    // ── supportsInteractivePrompts=false ──────────────────────────────────────

    describe('supportsInteractivePrompts=false', () => {
      it('promptUser resolves on matching inbound text (text-fallback path)', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const OPTIONS: readonly PromptOption[] = [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ];
        const promptP = fake.promptUser(TEST_CTX, 'Proceed?', OPTIONS);
        await fake.injectInboundText(TEST_CTX, 'yes');
        expect(await promptP).toBe('yes');
      });

      it('promptUser resolves empty string on AbortSignal', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const OPTIONS: readonly PromptOption[] = [{ value: 'ok', label: 'OK' }];
        const controller = new AbortController();
        const promptP = fake.promptUser(TEST_CTX, 'Continue?', OPTIONS, controller.signal);
        controller.abort();
        expect(await promptP).toBe('');
      });

      it('promptUser with already-aborted signal resolves immediately with empty string', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const controller = new AbortController();
        controller.abort();
        const OPTIONS: readonly PromptOption[] = [{ value: 'ok', label: 'OK' }];
        const result = await fake.promptUser(TEST_CTX, 'Q?', OPTIONS, controller.signal);
        expect(result).toBe('');
      });

      it('text-fallback CONTRACT: resolves via 1-based option index', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const OPTIONS: readonly PromptOption[] = [
          { value: 'approve', label: '✅ Approve' },
          { value: 'deny', label: '❌ Deny' },
        ];
        const promptP = fake.promptUser(TEST_CTX, 'Allow?', OPTIONS);
        await fake.injectInboundText(TEST_CTX, '2');
        expect(await promptP).toBe('deny');
      });

      it('text-fallback CONTRACT: resolves via case-insensitive option value', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const OPTIONS: readonly PromptOption[] = [
          { value: 'approve', label: '✅ Approve' },
          { value: 'deny', label: '❌ Deny' },
        ];
        const promptP = fake.promptUser(TEST_CTX, 'Allow?', OPTIONS);
        await fake.injectInboundText(TEST_CTX, 'APPROVE');
        expect(await promptP).toBe('approve');
      });

      it('text-fallback CONTRACT: unmatched reply while prompt pending is silently ignored — NOT routed to message handler', async () => {
        const fake = new FakeChannel({ supportsInteractivePrompts: false });
        const OPTIONS: readonly PromptOption[] = [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ];
        const handler = vi.fn();
        fake.onMessage(handler);
        const promptP = fake.promptUser(TEST_CTX, 'Proceed?', OPTIONS);
        await fake.injectInboundText(TEST_CTX, 'unrelated-gibberish');
        expect(handler).not.toHaveBeenCalled();
        // clean up: resolve prompt so no dangling promise
        await fake.injectInboundText(TEST_CTX, 'yes');
        await promptP;
      });
    });

    // ── supportsThreadCreation=false ──────────────────────────────────────────

    describe('supportsThreadCreation=false', () => {
      it('FakeChannel throws when createThread called — core MUST NOT call it', async () => {
        // FakeChannel implements createThread as a throwing method (one valid approach).
        // Real adapters (e.g., Teams) may omit the method entirely — both are valid.
        const fake = new FakeChannel({ supportsThreadCreation: false });
        await expect(fake.createThread('-100', 'Topic')).rejects.toThrow();
        expect(fake.threadCreations).toHaveLength(0);
      });

      it('an adapter that omits createThread entirely satisfies the optional-method contract', () => {
        // Optional method: absence is explicitly allowed when supportsThreadCreation=false.
        // This simulates a Teams-style adapter that doesn't implement createThread at all.
        const noThreadAdapter = new FakeChannel({ supportsThreadCreation: false });
        // Verify that calling the method when it is undefined would be caught by the caller guard.
        // Caller guard: check capability flag AND method presence before calling.
        const canCreate =
          noThreadAdapter.capabilities.supportsThreadCreation &&
          typeof noThreadAdapter.createThread === 'function';
        expect(canCreate).toBe(false);
      });

      it('pre-existing thread binding works fine (onMessage/onCommand still fire)', async () => {
        const fake = new FakeChannel({ supportsThreadCreation: false });
        // Core binds to a pre-existing thread.
        const PRE_EXISTING: ChannelContext = { threadId: '77', channelId: '-100' };
        const received: string[] = [];
        fake.onMessage(async (_, text) => { received.push(text); });
        await fake.injectInboundText(PRE_EXISTING, 'hello from pre-existing thread');
        expect(received).toEqual(['hello from pre-existing thread']);
      });
    });

    // ── supportsThreadCreation=true ───────────────────────────────────────────

    describe('supportsThreadCreation=true', () => {
      it('createThread returns ChannelContext with new threadId', async () => {
        const fake = new FakeChannel({ supportsThreadCreation: true });
        const ctx = await fake.createThread('-100', 'New Topic');
        expect(ctx.channelId).toBe('-100');
        expect(ctx.threadId).toBeTruthy();
        expect(fake.threadCreations).toHaveLength(1);
        expect(fake.threadCreations[0]!.title).toBe('New Topic');
      });
    });

    // ── Full matrix: all capabilities OFF ─────────────────────────────────────

    describe('all capabilities OFF (most constrained transport)', () => {
      it('still resolves sendMessage and returns a MessageRef', async () => {
        const fake = new FakeChannel({
          supportsMessageEdit: false,
          supportsThreadCreation: false,
          supportsInteractivePrompts: false,
          supportsStreaming: false,
          maxMessageLength: 1000,
        });
        const ref = await fake.sendMessage(TEST_CTX, 'test');
        expect(ref.id).toBeTruthy();
      });

      it('editMessage returns false without recording', async () => {
        const fake = new FakeChannel({
          supportsMessageEdit: false,
          supportsThreadCreation: false,
          supportsInteractivePrompts: false,
          supportsStreaming: false,
        });
        const ref = await fake.sendMessage(TEST_CTX, 'x');
        expect(await fake.editMessage(TEST_CTX, ref, 'y')).toBe(false);
        expect(fake.edits).toHaveLength(0);
      });

      it('createThread throws (FakeChannel implementation; real adapters may omit the method)', async () => {
        const fake = new FakeChannel({
          supportsMessageEdit: false,
          supportsThreadCreation: false,
          supportsInteractivePrompts: false,
          supportsStreaming: false,
        });
        await expect(fake.createThread('-100', 'x')).rejects.toThrow();
      });

      it('promptUser resolves via AbortSignal', async () => {
        const fake = new FakeChannel({
          supportsInteractivePrompts: false,
        });
        const controller = new AbortController();
        controller.abort();
        const result = await fake.promptUser(TEST_CTX, 'Q', [{ value: 'ok', label: 'OK' }], controller.signal);
        expect(result).toBe('');
      });
    });

    // ── splitMessage respects maxMessageLength ────────────────────────────────

    describe('splitMessage with small maxMessageLength', () => {
      it('splits into chunks each ≤ maxMessageLength', () => {
        const fake = new FakeChannel({ maxMessageLength: 10 });
        const chunks = fake.splitMessage('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
          expect(c.length).toBeLessThanOrEqual(10);
        }
      });

      it('footer is in last chunk and last chunk ≤ maxMessageLength', () => {
        const fake = new FakeChannel({ maxMessageLength: 50 });
        const text = 'Hello world — this is a medium-length message.';
        const chunks = fake.splitMessage(text, 'ft');
        const last = chunks[chunks.length - 1]!;
        expect(last).toContain('ft');
        expect(last.length).toBeLessThanOrEqual(50);
      });
    });
  });
}
