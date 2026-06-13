/**
 * TeamsChannel — stub adapter for Microsoft Teams (Phase 2a).
 *
 * Implements the ChannelPort contract with all Graph API-dependent operations
 * stubbed out. Phase 2b (corp fork) will wire the real Graph polling client,
 * send/edit calls, and Adaptive Card prompts.
 *
 * Capabilities (Phase 2a stub):
 *   supportsMessageEdit      = false  (OD-1: edit=false for Teams v1)
 *   supportsThreadCreation   = false  (pre-existing channels only in v1)
 *   supportsInteractivePrompts = false (text-fallback; Adaptive Cards in Phase 2b)
 *   supportsStreaming         = false  (OD-2: single send after full accumulation)
 *   maxMessageLength          = 28000  (Teams channel message limit)
 *
 * Formatting is delegated to ./formatting.ts and wired in Phase 2b; the stub keeps formatForTransport as identity.
 */

import type {
  ChannelPort,
  ChannelCapabilities,
  ChannelContext,
  MessageRef,
  PromptOption,
  MessageHandler,
  CommandHandler,
} from '../port.js';
import { registerChannel } from '../registry.js';

interface PendingPromptEntry {
  options: readonly PromptOption[];
  resolve: (value: string) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class TeamsChannel implements ChannelPort {
  readonly name = 'teams';

  readonly capabilities: ChannelCapabilities = {
    supportsMessageEdit: false,       // OD-1: no in-place edits for Teams v1
    supportsThreadCreation: false,    // pre-existing channels only; no createThread
    supportsInteractivePrompts: false, // text-fallback in stub; Adaptive Cards in Phase 2b
    supportsStreaming: false,          // OD-2: accumulate + single send
    maxMessageLength: 28000,
  };

  private messageHandler: MessageHandler | undefined;
  private readonly commandHandlers = new Map<string, CommandHandler>();
  private readonly pendingPrompts = new Map<string, PendingPromptEntry>();
  private nextMessageId = 1;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Throws until Phase 2b wires the real Graph polling client. */
  async start(): Promise<void> {
    throw new Error('[teams] not configured for live Graph');
  }

  /** No-op in stub mode — no connection to clean up. */
  async stop(): Promise<void> {
    // Intentional no-op: start() never establishes a connection in stub mode.
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /**
   * Returns an in-memory stub MessageRef without calling the Graph API.
   * Phase 2b will replace this with a real POST to
   * /teams/{team-id}/channels/{channel-id}/messages.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef> {
    // TODO Phase 2b: apply formatForTransport(text) before POSTing to Graph (contentType: html).
    return { id: String(this.nextMessageId++) };
  }

  /**
   * Always returns false — supportsMessageEdit=false (OD-1).
   * Core relay MUST NOT call editMessage() for this adapter.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async editMessage(ctx: ChannelContext, ref: MessageRef, text: string): Promise<boolean> {
    return false;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  /**
   * Identity transform in stub mode.
   * Phase 2b will delegate to src/channel/teams/formatting.ts,
   * which produces Teams HTML.
   */
  formatForTransport(markdown: string): string {
    return markdown;
  }

  /**
   * Simple character-boundary split respecting maxMessageLength (28 000).
   * When a footer is present and a split is needed, body capacity is reduced
   * to reserve space for the footer so it always lands intact on the last chunk.
   * Phase 2b may replace with word-boundary or HTML-aware splitting.
   */
  splitMessage(text: string, footer?: string): string[] {
    const max = this.capabilities.maxMessageLength;
    const separator = '\n\n';
    const full = footer ? `${text}${separator}${footer}` : text;

    // No split needed (common case — most messages fit in one chunk).
    if (full.length <= max) return [full];

    if (!footer) {
      // No footer: simple character-boundary split.
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += max) {
        chunks.push(text.slice(i, i + max));
      }
      return chunks;
    }

    // Footer present and split needed.
    const footerReserve = separator.length + footer.length;

    if (footerReserve >= max) {
      // Footer alone can't share a chunk with any body content: split body at
      // max, then split the footer block (separator + footer text) at max too.
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += max) {
        chunks.push(text.slice(i, i + max));
      }
      const footerBlock = `${separator}${footer}`;
      for (let i = 0; i < footerBlock.length; i += max) {
        chunks.push(footerBlock.slice(i, i + max));
      }
      return chunks;
    }

    // Footer fits alongside body: reserve footer space so it is never split
    // across a chunk boundary. Append it only to the last chunk.
    const bodyCapacity = max - footerReserve;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += bodyCapacity) {
      chunks.push(text.slice(i, i + bodyCapacity));
    }
    chunks[chunks.length - 1] += `${separator}${footer}`;
    return chunks;
  }

  // ── Interactive Prompts ────────────────────────────────────────────────────

  /**
   * Text-based prompt fallback (supportsInteractivePrompts=false).
   *
   * Posts the question and options as a plain text message, then waits for a
   * matching inbound reply (dispatched via dispatchInboundMessage). Prompt
   * state is scoped by context key ("channelId:threadId") so concurrent
   * prompts on different threads do not interfere. If a prompt is already
   * pending for the same context, it is resolved with '' before the new one
   * is registered. Resolves with '' when the AbortSignal fires.
   *
   * Phase 2b will replace this with Adaptive Card action buttons once Kat's
   * formatting module is wired in and supportsInteractivePrompts is set true.
   *
   * @param ctx      - Thread/channel context.
   * @param question - Prompt question text (already formatted by relay).
   * @param options  - Available choices.
   * @param signal   - Optional AbortSignal for abort-on-disconnect.
   */
  async promptUser(
    ctx: ChannelContext,
    question: string,
    options: readonly PromptOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) return '';
    if (options.length === 0) return '';

    const key = `${ctx.channelId}:${ctx.threadId}`;

    // Evict any prior pending prompt for this context without leaving it unsettled.
    const prior = this.pendingPrompts.get(key);
    if (prior) {
      this.pendingPrompts.delete(key);
      if (prior.abortHandler !== undefined) {
        prior.signal?.removeEventListener('abort', prior.abortHandler);
      }
      prior.resolve('');
    }

    const optionLines = options.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');

    return new Promise<string>((resolve) => {
      const entry: PendingPromptEntry = { options, resolve };

      if (signal) {
        const abortHandler = (): void => {
          if (this.pendingPrompts.get(key) === entry) {
            this.pendingPrompts.delete(key);
          }
          resolve('');
        };
        entry.signal = signal;
        entry.abortHandler = abortHandler;
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      // Register BEFORE sending so that any inbound reply or abort that
      // arrives during the sendMessage round-trip is not missed.
      this.pendingPrompts.set(key, entry);

      this.sendMessage(
        ctx,
        `${question}\n\nOptions:\n${optionLines}\n\nReply with the option number or name.`,
      ).catch(() => {
        // If send fails, clean up the entry so the prompt doesn't hang.
        if (this.pendingPrompts.get(key) === entry) {
          this.pendingPrompts.delete(key);
        }
        if (entry.abortHandler !== undefined) {
          entry.signal?.removeEventListener('abort', entry.abortHandler);
        }
        resolve('');
      });
    });
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  // ── Internal dispatch (used by Phase 2b polling loop) ─────────────────────

  /**
   * Dispatch an inbound text message from the polling loop (Phase 2b) or
   * from test helpers. Routing rules:
   *
   * - If a prompt is pending for this message's context key (channelId:threadId)
   *   and the text matches an option (by value or 1-based index), the pending
   *   prompt is resolved with that option's value and the message is consumed
   *   (NOT forwarded to the onMessage handler).
   * - If a prompt is pending but the text does not match any option, the message
   *   is silently ignored — it is NOT forwarded to the onMessage handler.
   * - If no prompt is pending for this context, the message is forwarded to the
   *   registered onMessage handler.
   *
   * This method is package-internal: the Phase 2b polling client will call it
   * for every message fetched from the Graph API.
   */
  protected dispatchInboundMessage(ctx: ChannelContext, text: string): Promise<void> {
    const key = `${ctx.channelId}:${ctx.threadId}`;
    const pending = this.pendingPrompts.get(key);

    if (pending) {
      const { options, resolve } = pending;
      const normalised = text.trim().toLowerCase();

      // Match by 1-based index ("1", "2", …) or by option value (case-insensitive).
      const byIndex = /^\d+$/.test(normalised)
        ? options[parseInt(normalised, 10) - 1]
        : undefined;
      const matched = byIndex ?? options.find((o) => o.value.toLowerCase() === normalised);

      if (matched) {
        this.pendingPrompts.delete(key);
        if (pending.abortHandler !== undefined) {
          pending.signal?.removeEventListener('abort', pending.abortHandler);
        }
        resolve(matched.value);
        return Promise.resolve();
      }

      // Invalid reply while a prompt is pending: silently ignore — do NOT route
      // to the message handler, which would confuse the relay with a stray message.
      return Promise.resolve();
    }

    if (this.messageHandler) {
      return this.messageHandler(ctx, text);
    }
    return Promise.resolve();
  }

  /**
   * Dispatch an inbound slash command from the polling loop (Phase 2b).
   */
  protected dispatchInboundCommand(command: string, ctx: ChannelContext, args: string): Promise<void> {
    const handler = this.commandHandlers.get(command);
    return handler ? handler(ctx, args) : Promise.resolve();
  }
}

// ── Self-registration ──────────────────────────────────────────────────────

registerChannel('teams', (cfg) => {
  if (!cfg.teamsTenantId || !cfg.teamsClientId || !cfg.teamsClientSecret) {
    throw new Error(
      '[teams] TEAMS_TENANT_ID, TEAMS_CLIENT_ID, and TEAMS_CLIENT_SECRET are required ' +
      'when REACH_CHANNEL=teams',
    );
  }
  if (!cfg.teamsTeamId || !cfg.teamsChannelId) {
    throw new Error(
      '[teams] TEAMS_TEAM_ID and TEAMS_CHANNEL_ID are required when REACH_CHANNEL=teams',
    );
  }
  return new TeamsChannel();
});
