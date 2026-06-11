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
 * Do NOT import src/channel/teams/formatting.ts here — that module is owned by
 * Kat (P2a-5) and will be wired in Phase 2b. Keep this stub self-contained.
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
  private pendingTextPrompt?: {
    options: readonly PromptOption[];
    resolve: (value: string) => void;
  };
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
   * Phase 2b will delegate to src/channel/teams/formatting.ts (Kat, P2a-5)
   * which produces the Teams HTML / Adaptive Card JSON.
   */
  formatForTransport(markdown: string): string {
    return markdown;
  }

  /**
   * Simple character-boundary split respecting maxMessageLength (28 000).
   * Phase 2b may replace with word-boundary or HTML-aware splitting.
   */
  splitMessage(text: string, footer?: string): string[] {
    const max = this.capabilities.maxMessageLength;
    const full = footer ? `${text}\n\n${footer}` : text;
    if (full.length <= max) return [full];

    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += max) {
      chunks.push(full.slice(i, i + max));
    }
    return chunks;
  }

  // ── Interactive Prompts ────────────────────────────────────────────────────

  /**
   * Text-based prompt fallback (supportsInteractivePrompts=false).
   *
   * Posts the question and options as a plain text message, then waits for a
   * matching inbound reply (dispatched via dispatchInboundMessage). Resolves
   * with '' when the AbortSignal fires (aborted / session evicted).
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

    const optionLines = options.map((o) => `  ${o.value}: ${o.label}`).join('\n');
    await this.sendMessage(ctx, `${question}\n\nOptions:\n${optionLines}`);

    return new Promise<string>((resolve) => {
      this.pendingTextPrompt = { options, resolve };

      signal?.addEventListener('abort', () => {
        if (this.pendingTextPrompt) {
          delete this.pendingTextPrompt;
          resolve('');
        }
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
   * from test helpers. Resolves any pending text-fallback prompt whose options
   * match the text value, then fires the registered onMessage handler.
   *
   * This method is package-internal: the Phase 2b polling client will call it
   * for every message fetched from the Graph API.
   */
  protected dispatchInboundMessage(ctx: ChannelContext, text: string): Promise<void> {
    if (this.pendingTextPrompt) {
      const matched = this.pendingTextPrompt.options.find((o) => o.value === text);
      if (matched) {
        const { resolve } = this.pendingTextPrompt;
        delete this.pendingTextPrompt;
        resolve(matched.value);
        return Promise.resolve();
      }
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
