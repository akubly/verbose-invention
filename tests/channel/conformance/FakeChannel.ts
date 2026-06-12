/**
 * FakeChannel — a configurable in-memory ChannelPort for conformance testing.
 *
 * Supports toggling each capability independently so the conformance kit can
 * drive the full fallback matrix without any network I/O.
 *
 * Design rules:
 *  - sendMessage always succeeds and returns a numeric (incrementing) MessageRef.
 *  - editMessage succeeds iff capabilities.supportsMessageEdit is true.
 *  - promptUser:
 *      • supportsInteractivePrompts=true  → resolves immediately with options[0].value
 *      • supportsInteractivePrompts=false → waits for the first inbound text message
 *        that matches an option value, or resolves '' on AbortSignal.
 *  - createThread succeeds iff capabilities.supportsThreadCreation is true.
 *  - Handlers registered via onMessage/onCommand are captured for inspection.
 */

import type {
  ChannelPort,
  ChannelCapabilities,
  ChannelContext,
  MessageRef,
  PromptOption,
  MessageHandler,
  CommandHandler,
} from '../../../src/channel/port.js';

export interface FakeChannelOpts {
  supportsMessageEdit?: boolean;
  supportsThreadCreation?: boolean;
  supportsInteractivePrompts?: boolean;
  supportsStreaming?: boolean;
  maxMessageLength?: number;
}

export class FakeChannel implements ChannelPort {
  readonly name = 'fake';

  readonly capabilities: ChannelCapabilities;

  /** All sendMessage calls in order: [ctx, text] */
  readonly sends: Array<{ ctx: ChannelContext; text: string }> = [];
  /** All editMessage calls in order: [ctx, ref, text] */
  readonly edits: Array<{ ctx: ChannelContext; ref: MessageRef; text: string }> = [];
  /** All createThread calls in order: [channelId, title] */
  readonly threadCreations: Array<{ channelId: string; title: string }> = [];

  private nextMessageId = 1;
  private messageHandler: MessageHandler | undefined;
  readonly registeredCommands = new Map<string, CommandHandler>();

  /** Pending text-fallback prompt: resolves when matching inbound text arrives or abort fires. */
  private pendingTextPrompt?: {
    options: readonly PromptOption[];
    resolve: (value: string) => void;
  };

  started = false;
  stopped = false;

  constructor(opts: FakeChannelOpts = {}) {
    this.capabilities = {
      supportsMessageEdit: opts.supportsMessageEdit ?? true,
      supportsThreadCreation: opts.supportsThreadCreation ?? true,
      supportsInteractivePrompts: opts.supportsInteractivePrompts ?? true,
      supportsStreaming: opts.supportsStreaming ?? true,
      maxMessageLength: opts.maxMessageLength ?? 4096,
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef> {
    this.sends.push({ ctx, text });
    const ref: MessageRef = { id: String(this.nextMessageId++) };

    // If there is a pending text-prompt, check if this inbound-originated send
    // happens to resolve it (text-prompt fallback scenario isn't triggered by
    // sendMessage itself — that comes from injectInboundText).
    return ref;
  }

  async editMessage(ctx: ChannelContext, ref: MessageRef, text: string): Promise<boolean> {
    if (!this.capabilities.supportsMessageEdit) {
      return false;
    }
    this.edits.push({ ctx, ref, text });
    return true;
  }

  formatForTransport(markdown: string): string {
    // Identity transform — no platform-specific escaping.
    return markdown;
  }

  splitMessage(text: string, footer?: string): string[] {
    const max = this.capabilities.maxMessageLength;
    const full = footer ? `${text}\n\n${footer}` : text;
    if (full.length <= max) return [full];

    // Simple character-boundary split.
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += max) {
      chunks.push(full.slice(i, i + max));
    }
    return chunks;
  }

  async promptUser(
    _ctx: ChannelContext,
    _question: string,
    options: readonly PromptOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.capabilities.supportsInteractivePrompts) {
      // Interactive path: resolve immediately with first option.
      return options[0]?.value ?? '';
    }

    // Text-fallback path: wait for injectInboundText() or abort.
    return new Promise<string>((resolve) => {
      if (signal?.aborted) {
        resolve('');
        return;
      }

      this.pendingTextPrompt = { options, resolve };

      signal?.addEventListener('abort', () => {
        if (this.pendingTextPrompt) {
          this.pendingTextPrompt = undefined;
          resolve('');
        }
      });
    });
  }

  async createThread(channelId: string, title: string): Promise<ChannelContext> {
    if (!this.capabilities.supportsThreadCreation) {
      throw new Error('[fake] createThread called but supportsThreadCreation=false');
    }
    this.threadCreations.push({ channelId, title });
    return { channelId, threadId: String(this.nextMessageId++) };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.registeredCommands.set(command, handler);
  }

  // ── Test helpers ───────────────────────────────────────────────────────────

  /**
   * Simulate an inbound text message from the user.
   *
   * LOCKED CONTRACT (matches TeamsChannel.dispatchInboundMessage):
   *   - While a prompt is pending: match trimmed+case-insensitive against option values
   *     OR as a 1-based option index. If matched, resolves the prompt. If UNMATCHED,
   *     the message is SILENTLY IGNORED — it is NOT routed to the messageHandler.
   *   - When no prompt is pending: routes to the registered messageHandler as normal.
   */
  async injectInboundText(ctx: ChannelContext, text: string): Promise<void> {
    if (this.pendingTextPrompt) {
      const { options, resolve } = this.pendingTextPrompt;
      const normalised = text.trim().toLowerCase();

      // Match by 1-based index ("1", "2", …) or by option value (case-insensitive).
      const byIndex = /^\d+$/.test(normalised)
        ? options[parseInt(normalised, 10) - 1]
        : undefined;
      const matched = byIndex ?? options.find((o) => o.value.toLowerCase() === normalised);

      if (matched) {
        this.pendingTextPrompt = undefined;
        resolve(matched.value);
      }
      // Unmatched reply while prompt pending: silently ignore — do NOT route to messageHandler.
      return;
    }

    if (this.messageHandler) {
      await this.messageHandler(ctx, text);
    }
  }

  /**
   * Simulate an inbound slash command dispatch.
   */
  async injectCommand(command: string, ctx: ChannelContext, args: string): Promise<void> {
    const handler = this.registeredCommands.get(command);
    if (handler) await handler(ctx, args);
  }

  /** Reset call-log arrays between tests. */
  reset(): void {
    this.sends.length = 0;
    this.edits.length = 0;
    this.threadCreations.length = 0;
    this.nextMessageId = 1;
    this.messageHandler = undefined;
    this.registeredCommands.clear();
    this.pendingTextPrompt = undefined;
    this.started = false;
    this.stopped = false;
  }
}
