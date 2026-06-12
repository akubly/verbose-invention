/**
 * TeamsChannel conformance test (P2a-6).
 *
 * Runs the generic conformance kit against TeamsChannel with no real Graph
 * access. TeamsChannel is self-contained (no constructor dependencies) so
 * no mock injection is needed — the stub works in-memory out of the box.
 *
 * skipLifecycle: true because start() intentionally throws
 * '[teams] not configured for live Graph' (Phase 2b live work).
 *
 * I4 optional-createThread: supportsThreadCreation=false means createThread
 * is OMITTED entirely from TeamsChannel — the kit MUST pass without it.
 */

import { describe, it, expect, vi } from 'vitest';
import { TeamsChannel } from '../../../src/channel/teams/index.js';
import { runChannelPortConformance } from './runner.js';
import type { ChannelContext } from '../../../src/channel/port.js';

// ── TestableTeamsChannel ──────────────────────────────────────────────────────
//
// TeamsChannel.dispatchInboundMessage and dispatchInboundCommand are protected.
// Subclass exposes them for test injection without modifying src/.

class TestableTeamsChannel extends TeamsChannel {
  injectInboundText(ctx: ChannelContext, text: string): Promise<void> {
    return this.dispatchInboundMessage(ctx, text);
  }

  injectCommand(command: string, ctx: ChannelContext, args: string): Promise<void> {
    return this.dispatchInboundCommand(command, ctx, args);
  }
}

// ── Generic conformance kit ───────────────────────────────────────────────────
//
// skipLifecycle=true: start() throws until Phase 2b wires real Graph polling.
// The kit's supportsThreadCreation=false path verifies the I4 contract:
// it only checks capabilities.supportsThreadCreation===false and does NOT call
// createThread — which is absent on TeamsChannel (as required by I4).

runChannelPortConformance(() => new TeamsChannel(), {
  name: 'TeamsChannel',
  skipLifecycle: true,
});

// ── Declared capability assertions (anti-lie guarantee) ───────────────────────

describe('TeamsChannel — declared capabilities (anti-lie)', () => {
  it('declares {edit:false, threadCreation:false, interactivePrompts:false, streaming:false, maxMessageLength:28000}', () => {
    const ch = new TeamsChannel();
    expect(ch.capabilities.supportsMessageEdit).toBe(false);
    expect(ch.capabilities.supportsThreadCreation).toBe(false);
    expect(ch.capabilities.supportsInteractivePrompts).toBe(false);
    expect(ch.capabilities.supportsStreaming).toBe(false);
    expect(ch.capabilities.maxMessageLength).toBe(28000);
  });

  it('name is "teams"', () => {
    expect(new TeamsChannel().name).toBe('teams');
  });
});

// ── I4: optional-createThread path ───────────────────────────────────────────
//
// Per noble-six-i4-createthread-optional.md: when supportsThreadCreation=false,
// the adapter MUST omit createThread entirely (absence is the correct impl).
// TeamsChannel omits it; the caller guard must detect both the capability flag
// AND method absence before calling.

describe('TeamsChannel — I4 optional-createThread (supportsThreadCreation=false)', () => {
  it('supportsThreadCreation is false', () => {
    const ch = new TeamsChannel();
    expect(ch.capabilities.supportsThreadCreation).toBe(false);
  });

  it('createThread method is absent on the instance', () => {
    const ch = new TeamsChannel();
    // Optional method — absence is explicitly correct when capability=false.
    expect(ch.createThread).toBeUndefined();
  });

  it('caller guard (capability flag AND method presence) evaluates to false', () => {
    const ch = new TeamsChannel();
    const canCreate =
      ch.capabilities.supportsThreadCreation && typeof ch.createThread === 'function';
    expect(canCreate).toBe(false);
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('TeamsChannel — lifecycle', () => {
  it('start() throws with "[teams] not configured for live Graph"', async () => {
    const ch = new TeamsChannel();
    await expect(ch.start()).rejects.toThrow('[teams] not configured for live Graph');
  });

  it('stop() resolves without throwing (no-op in stub mode)', async () => {
    const ch = new TeamsChannel();
    await expect(ch.stop()).resolves.toBeUndefined();
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const ch = new TeamsChannel();
    await ch.stop();
    await expect(ch.stop()).resolves.toBeUndefined();
  });
});

// ── sendMessage in-memory stub ────────────────────────────────────────────────

describe('TeamsChannel — sendMessage in-memory stub', () => {
  it('returns a MessageRef with a non-empty id string', async () => {
    const ch = new TeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const ref = await ch.sendMessage(ctx, 'hello teams');
    expect(typeof ref.id).toBe('string');
    expect(ref.id.length).toBeGreaterThan(0);
  });

  it('successive sendMessage calls return distinct ids', async () => {
    const ch = new TeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const ref1 = await ch.sendMessage(ctx, 'first');
    const ref2 = await ch.sendMessage(ctx, 'second');
    expect(ref1.id).not.toBe(ref2.id);
  });

  it('accepts empty-string threadId (General Topic) without throwing', async () => {
    const ch = new TeamsChannel();
    await expect(
      ch.sendMessage({ threadId: '', channelId: 'channel-1' }, 'general message'),
    ).resolves.toBeDefined();
  });
});

// ── editMessage always returns false (supportsMessageEdit=false) ───────────────

describe('TeamsChannel — editMessage always false (OD-1)', () => {
  it('returns false without throwing', async () => {
    const ch = new TeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const ref = await ch.sendMessage(ctx, 'original');
    const result = await ch.editMessage(ctx, ref, 'edited');
    expect(result).toBe(false);
  });
});

// ── promptUser text-fallback (supportsInteractivePrompts=false) ───────────────
//
// TeamsChannel.promptUser awaits this.sendMessage() before setting
// pendingTextPrompt/abort-listener. Tests flush the microtask queue via
// await Promise.resolve() so that internal await completes before we inject input.

describe('TeamsChannel — promptUser text-fallback', () => {
  const OPTIONS = [
    { value: 'approve', label: '✅ Approve' },
    { value: 'deny', label: '❌ Deny' },
  ] as const;

  it('resolves with "" when AbortSignal is already aborted (pre-abort)', async () => {
    const ch = new TeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const controller = new AbortController();
    controller.abort();
    const result = await ch.promptUser(ctx, 'Allow?', OPTIONS, controller.signal);
    expect(result).toBe('');
  });

  it('resolves with matching option value when inbound text matches', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const promptPromise = ch.promptUser(ctx, 'Allow?', OPTIONS);
    // flush so promptUser's sendMessage await completes and pendingTextPrompt is set
    await Promise.resolve();
    await ch.injectInboundText(ctx, 'approve');
    expect(await promptPromise).toBe('approve');
  });

  it('resolves via 1-based option index', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const promptPromise = ch.promptUser(ctx, 'Allow?', OPTIONS);
    await Promise.resolve();
    await ch.injectInboundText(ctx, '2');
    expect(await promptPromise).toBe('deny');
  });

  it('unmatched reply does NOT call the message handler while prompt is pending', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const handler = vi.fn();
    ch.onMessage(handler);
    const controller = new AbortController();
    const promptPromise = ch.promptUser(ctx, 'Allow?', OPTIONS, controller.signal);
    await Promise.resolve();
    await ch.injectInboundText(ctx, 'unrelated');
    expect(handler).not.toHaveBeenCalled();
    controller.abort();
    await promptPromise;
  });
});

// ── onMessage / onCommand wiring ──────────────────────────────────────────────

describe('TeamsChannel — inbound handler wiring', () => {
  it('onMessage fires the registered handler', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const received: string[] = [];
    ch.onMessage(async (_, text) => { received.push(text); });
    await ch.injectInboundText(ctx, 'ping');
    expect(received).toEqual(['ping']);
  });

  it('second onMessage call replaces the first handler', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    const log: string[] = [];
    ch.onMessage(async (_, text) => { log.push('first:' + text); });
    ch.onMessage(async (_, text) => { log.push('second:' + text); });
    await ch.injectInboundText(ctx, 'hi');
    expect(log).toEqual(['second:hi']);
  });

  it('onCommand fires the registered handler with correct args', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    let captured: { ctx: ChannelContext; args: string } | undefined;
    ch.onCommand('list', async (c, args) => { captured = { ctx: c, args }; });
    await ch.injectCommand('list', ctx, 'all');
    expect(captured).toBeDefined();
    expect(captured!.args).toBe('all');
    expect(captured!.ctx.threadId).toBe('1');
  });

  it('unregistered commands are silently ignored', async () => {
    const ch = new TestableTeamsChannel();
    const ctx: ChannelContext = { threadId: '1', channelId: 'channel-1' };
    await expect(ch.injectCommand('unknown', ctx, '')).resolves.toBeUndefined();
  });
});

// ── formatForTransport + splitMessage ────────────────────────────────────────

describe('TeamsChannel — formatting', () => {
  it('formatForTransport returns a string (identity in stub mode)', () => {
    const ch = new TeamsChannel();
    const result = ch.formatForTransport('**bold** _italic_');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('splitMessage returns chunks each ≤ 28000 characters', () => {
    const ch = new TeamsChannel();
    const longText = 'X'.repeat(28000 * 3);
    const chunks = ch.splitMessage(longText);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(28000);
    }
  });

  it('footer appears in the last chunk', () => {
    const ch = new TeamsChannel();
    const chunks = ch.splitMessage('some teams message', 'session footer');
    expect(chunks[chunks.length - 1]).toContain('session footer');
  });
});
