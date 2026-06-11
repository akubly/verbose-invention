/**
 * TeamsChannel.promptUser — text-fallback design and coverage tests (P2a-5).
 *
 * TeamsChannel.supportsInteractivePrompts = false, so promptUser() must:
 *   1. Post the question + numbered option list as a plain-text message.
 *   2. Wait for a matching inbound reply dispatched via dispatchInboundMessage().
 *   3. Accept replies case-insensitively and whitespace-tolerantly.
 *   4. Accept a 1-based option number in place of the option value.
 *   5. Silently ignore invalid/unmatched replies (keep prompt open, do NOT route
 *      the stray message to the registered onMessage handler).
 *   6. Resolve with '' when the AbortSignal fires (abort-on-disconnect).
 *   7. Resolve with '' immediately for an empty options array.
 */

import { describe, it, expect, vi } from 'vitest';
import { TeamsChannel } from '../../../src/channel/teams/index.js';
import type { ChannelContext, PromptOption, MessageRef } from '../../../src/channel/port.js';

// ── Test subclass ─────────────────────────────────────────────────────────────
// Exposes dispatchInboundMessage (protected) and captures sendMessage calls.

class TestTeamsChannel extends TeamsChannel {
  readonly sends: Array<{ ctx: ChannelContext; text: string }> = [];
  private _nextId = 1;

  override async sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef> {
    this.sends.push({ ctx, text });
    return { id: String(this._nextId++) };
  }

  /** Simulate an inbound text message (e.g., from the Phase 2b polling loop). */
  async injectInbound(ctx: ChannelContext, text: string): Promise<void> {
    return this.dispatchInboundMessage(ctx, text);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTX: ChannelContext = { channelId: 'ch-1', threadId: 'th-1' };

const APPROVE_DENY: readonly PromptOption[] = [
  { value: 'approve', label: '✅ Approve' },
  { value: 'deny', label: '❌ Deny' },
];

const THREE_OPTS: readonly PromptOption[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'maybe', label: 'Maybe' },
];

function makeChannel(): TestTeamsChannel {
  return new TestTeamsChannel();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('TeamsChannel.promptUser — plain-text rendering', () => {
  it('sends exactly one message containing the question', async () => {
    const ch = makeChannel();
    const question = 'Do you want to proceed?';
    const p = ch.promptUser(CTX, question, APPROVE_DENY);

    // Let the send complete before asserting.
    await Promise.resolve();

    expect(ch.sends).toHaveLength(1);
    expect(ch.sends[0]!.text).toContain(question);

    // Resolve the prompt so no dangling promise.
    await ch.injectInbound(CTX, 'approve');
    await p;
  });

  it('includes each option label (human-readable) in the sent message', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    const body = ch.sends[0]!.text;
    expect(body).toContain('✅ Approve');
    expect(body).toContain('❌ Deny');

    await ch.injectInbound(CTX, 'approve');
    await p;
  });

  it('numbers the options starting at 1', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    const body = ch.sends[0]!.text;
    expect(body).toContain('1.');
    expect(body).toContain('2.');

    await ch.injectInbound(CTX, 'approve');
    await p;
  });

  it('includes a reply instruction in the sent message', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    // Instruction must tell the user HOW to reply.
    expect(ch.sends[0]!.text).toMatch(/reply with/i);

    await ch.injectInbound(CTX, 'approve');
    await p;
  });

  it('sends to the supplied ChannelContext', async () => {
    const ch = makeChannel();
    const ctx: ChannelContext = { channelId: 'ch-99', threadId: 'th-99' };
    const p = ch.promptUser(ctx, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    expect(ch.sends[0]!.ctx).toEqual(ctx);

    await ch.injectInbound(ctx, 'approve');
    await p;
  });
});

// ── Valid reply matching ──────────────────────────────────────────────────────

describe('TeamsChannel.promptUser — valid reply resolves with option value', () => {
  it('resolves with the first option value when exact value is sent', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, 'approve');
    await expect(p).resolves.toBe('approve');
  });

  it('resolves with the second option value when its exact value is sent', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, 'deny');
    await expect(p).resolves.toBe('deny');
  });

  it('resolves via option number "1" (1-based index)', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, '1');
    await expect(p).resolves.toBe('approve');
  });

  it('resolves via option number "2"', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, '2');
    await expect(p).resolves.toBe('deny');
  });

  it('resolves via option number "3" for a 3-option list', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', THREE_OPTS);
    await Promise.resolve();
    await ch.injectInbound(CTX, '3');
    await expect(p).resolves.toBe('maybe');
  });
});

// ── Case-insensitive and whitespace-tolerant matching ─────────────────────────

describe('TeamsChannel.promptUser — case-insensitive matching', () => {
  it('matches UPPERCASE value ("APPROVE")', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, 'APPROVE');
    await expect(p).resolves.toBe('approve');
  });

  it('matches mixed-case value ("Deny")', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, 'Deny');
    await expect(p).resolves.toBe('deny');
  });

  it('matches value with leading/trailing whitespace ("  approve  ")', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, '  approve  ');
    await expect(p).resolves.toBe('approve');
  });

  it('matches option number with surrounding whitespace (" 1 ")', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();
    await ch.injectInbound(CTX, ' 1 ');
    await expect(p).resolves.toBe('approve');
  });
});

// ── Invalid reply handling ────────────────────────────────────────────────────

describe('TeamsChannel.promptUser — invalid reply handling', () => {
  it('keeps the prompt pending after an unrecognised reply', async () => {
    const ch = makeChannel();
    let resolved = false;
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY).then((v) => {
      resolved = true;
      return v;
    });
    await Promise.resolve();

    await ch.injectInbound(CTX, 'maybe');   // not a valid option
    await Promise.resolve();

    expect(resolved).toBe(false);

    // Clean up: resolve with a valid reply.
    await ch.injectInbound(CTX, 'approve');
    await expect(p).resolves.toBe('approve');
  });

  it('does NOT route an unmatched message to the onMessage handler while a prompt is pending', async () => {
    const ch = makeChannel();
    const messageHandler = vi.fn();
    ch.onMessage(messageHandler);

    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    await ch.injectInbound(CTX, 'gibberish');
    await Promise.resolve();

    expect(messageHandler).not.toHaveBeenCalled();

    // Resolve and verify handler is still callable for post-prompt messages.
    await ch.injectInbound(CTX, 'approve');
    await p;

    await ch.injectInbound(CTX, 'hello after');
    expect(messageHandler).toHaveBeenCalledOnce();
  });

  it('accepts a valid reply after one or more invalid replies', async () => {
    const ch = makeChannel();
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    await ch.injectInbound(CTX, 'nope');
    await ch.injectInbound(CTX, 'still nope');
    await ch.injectInbound(CTX, 'deny');

    await expect(p).resolves.toBe('deny');
  });

  it('ignores out-of-range index ("0") as an invalid reply', async () => {
    const ch = makeChannel();
    let resolved = false;
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY).then((v) => {
      resolved = true;
      return v;
    });
    await Promise.resolve();

    await ch.injectInbound(CTX, '0');  // 0 is not a valid 1-based index
    await Promise.resolve();
    expect(resolved).toBe(false);

    await ch.injectInbound(CTX, 'approve');
    await expect(p).resolves.toBe('approve');
  });

  it('ignores out-of-range index ("99") as an invalid reply', async () => {
    const ch = makeChannel();
    let resolved = false;
    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY).then((v) => {
      resolved = true;
      return v;
    });
    await Promise.resolve();

    await ch.injectInbound(CTX, '99');  // no 99th option
    await Promise.resolve();
    expect(resolved).toBe(false);

    await ch.injectInbound(CTX, 'deny');
    await expect(p).resolves.toBe('deny');
  });
});

// ── Abort-signal cancellation ─────────────────────────────────────────────────

describe('TeamsChannel.promptUser — abort-signal cancellation', () => {
  it('returns "" without sending if signal is already aborted before the call', async () => {
    const ch = makeChannel();
    const ac = new AbortController();
    ac.abort();

    const result = await ch.promptUser(CTX, 'Q?', APPROVE_DENY, ac.signal);

    expect(result).toBe('');
    expect(ch.sends).toHaveLength(0);
  });

  it('returns "" when signal fires after the prompt message is sent', async () => {
    const ch = makeChannel();
    const ac = new AbortController();

    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY, ac.signal);
    await Promise.resolve(); // let sendMessage complete

    expect(ch.sends).toHaveLength(1); // message was sent

    ac.abort();
    await Promise.resolve();

    await expect(p).resolves.toBe('');
  });

  it('does not resolve twice if abort fires after a valid reply already resolved it', async () => {
    const ch = makeChannel();
    const ac = new AbortController();

    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY, ac.signal);
    await Promise.resolve();

    await ch.injectInbound(CTX, 'approve');
    const result = await p;

    // Abort fires after resolution — must not throw or double-resolve.
    ac.abort();
    await Promise.resolve();

    expect(result).toBe('approve');
  });
});

// ── No-options edge case ──────────────────────────────────────────────────────

describe('TeamsChannel.promptUser — no-options edge case', () => {
  it('resolves "" immediately without sending a message when options is empty', async () => {
    const ch = makeChannel();
    const result = await ch.promptUser(CTX, 'Q?', []);
    expect(result).toBe('');
    expect(ch.sends).toHaveLength(0);
  });

  it('resolves "" for empty options even when a signal is provided', async () => {
    const ch = makeChannel();
    const ac = new AbortController();
    const result = await ch.promptUser(CTX, 'Q?', [], ac.signal);
    expect(result).toBe('');
    expect(ch.sends).toHaveLength(0);
  });
});

// ── Interaction with onMessage handler ───────────────────────────────────────

describe('TeamsChannel.promptUser — onMessage handler interaction', () => {
  it('routes normal messages to onMessage when no prompt is pending', async () => {
    const ch = makeChannel();
    const messageHandler = vi.fn<[ChannelContext, string], Promise<void>>().mockResolvedValue(undefined);
    ch.onMessage(messageHandler);

    await ch.injectInbound(CTX, 'hello');
    expect(messageHandler).toHaveBeenCalledWith(CTX, 'hello');
  });

  it('does not call onMessage for the matched prompt reply itself', async () => {
    const ch = makeChannel();
    const messageHandler = vi.fn<[ChannelContext, string], Promise<void>>().mockResolvedValue(undefined);
    ch.onMessage(messageHandler);

    const p = ch.promptUser(CTX, 'Q?', APPROVE_DENY);
    await Promise.resolve();

    await ch.injectInbound(CTX, 'approve');
    await p;

    expect(messageHandler).not.toHaveBeenCalled();
  });
});
