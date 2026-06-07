/**
 * Channel-layer port — transport-agnostic contract for communications channels.
 *
 * This is the seam between Reach's core (relay, sessions, copilot SDK) and the
 * messaging platform (Telegram, Teams, Slack, Discord, …). The core depends
 * ONLY on this interface; concrete adapters live behind it.
 *
 * Design principles:
 *   - Opaque string identifiers everywhere (no Telegram `number` types).
 *   - Transport owns formatting and message splitting (no shared MarkdownV2).
 *   - Capabilities descriptor for graceful degradation across N transports.
 *   - Startup-only selection via REACH_CHANNEL; no runtime hot-swap.
 *
 * See ADR: .squad/decisions/inbox/noble-six-comms-channel-abstraction-adr.md
 *
 * FALLBACK BEHAVIORS (must be implemented by the core relay, not the adapter):
 *
 *   supportsMessageEdit = false:
 *     Core MUST NOT call editMessage(). Instead of placeholder → stream-edit →
 *     final-edit, core sends a single message with the complete response when
 *     the SDK stream finishes. No intermediate "…" placeholder.
 *
 *   supportsStreaming = false:
 *     Core sends a "thinking…" placeholder via sendMessage(), then replaces it
 *     with the final response via editMessage() (if edits are supported) or
 *     sends the final response as a new message (if edits are also unsupported).
 *     No intermediate stream edits.
 *
 *   supportsInteractivePrompts = false:
 *     Core falls back to a text-based permission prompt: sends a message like
 *     "Tool X wants to run Y — reply 'yes' to approve" and waits for an
 *     inbound text message matching 'yes'/'no'. promptUser() MUST still work
 *     (the adapter implements the text fallback internally), but the core
 *     should prefer the text path when this capability is false.
 *
 *   supportsThreadCreation = false:
 *     Core MUST NOT call createThread(). Sessions must be bound to
 *     pre-existing threads/conversations. The /new command flow should
 *     require the user to create a thread first, then run /new inside it.
 *
 *   supportsThreadCreation = true:
 *     Core MAY call createThread() to programmatically create a thread
 *     (e.g., AFK mode topic creation). The adapter returns a ChannelContext
 *     for the new thread.
 */

// ── Context & References ────────────────────────────────────────────

/** Opaque reference to a thread/conversation within a channel. */
export interface ChannelContext {
  /** Opaque thread or topic identifier (stringified). */
  readonly threadId: string;
  /** Opaque channel or chat identifier (stringified). */
  readonly channelId: string;
}

/**
 * Opaque reference to a sent message, used for subsequent edits.
 * The adapter decides what goes inside; the core treats it as a token.
 */
export interface MessageRef {
  /** Opaque message identifier. */
  readonly id: string;
}

// ── Capabilities ────────────────────────────────────────────────────

/**
 * Declares which optional features a transport supports.
 *
 * The core relay checks these flags BEFORE calling optional methods.
 * Adapters MUST return accurate values — the conformance test kit (P1-7)
 * validates that declared capabilities match actual behavior.
 */
export interface ChannelCapabilities {
  /** Can outbound messages be edited in-place after sending? */
  readonly supportsMessageEdit: boolean;
  /**
   * Can the adapter create new threads/topics on demand?
   * When false, sessions must bind to pre-existing threads.
   */
  readonly supportsThreadCreation: boolean;
  /** Can the adapter display interactive buttons/actions for prompts? */
  readonly supportsInteractivePrompts: boolean;
  /**
   * Does edit-in-place streaming make sense for this transport?
   * When false, core skips intermediate edits and sends the final response
   * as a single message. Typically false when edits are rate-limited or
   * expensive (e.g., Teams Graph API at ~2 req/sec shared budget).
   */
  readonly supportsStreaming: boolean;
  /** Transport's maximum message size in characters. */
  readonly maxMessageLength: number;
}

// ── Prompt Types ────────────────────────────────────────────────────

/** A single option in an interactive prompt (button, action, etc.). */
export interface PromptOption {
  /** Machine-readable value returned when this option is selected. */
  readonly value: string;
  /** Human-readable label displayed to the user. */
  readonly label: string;
}

// ── Handler Signatures ──────────────────────────────────────────────

/**
 * Handler for inbound text messages (non-command messages in a thread).
 * The core relay wires this to dispatch messages to the linked SDK session.
 */
export type MessageHandler = (ctx: ChannelContext, text: string) => Promise<void>;

/**
 * Handler for inbound slash commands (e.g., /new, /list, /remove).
 * `args` is the raw text after the command name, trimmed.
 */
export type CommandHandler = (ctx: ChannelContext, args: string) => Promise<void>;

// ── Channel Port ────────────────────────────────────────────────────

/**
 * Transport-agnostic communications channel port.
 *
 * Each messaging platform (Telegram, Teams, Slack, Discord) implements this
 * interface. The core relay depends only on ChannelPort — never on platform
 * SDKs directly.
 *
 * Adapters are selected at startup via `REACH_CHANNEL` and registered in the
 * transport registry (see ./registry.ts). One adapter is active per daemon
 * lifetime; there is no runtime hot-swap.
 */
export interface ChannelPort {
  /** Transport name (e.g., 'telegram', 'teams', 'slack'). Matches REACH_CHANNEL value. */
  readonly name: string;

  /** Declares which optional features this transport supports. */
  readonly capabilities: ChannelCapabilities;

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Initialize the transport (connect, authenticate, start polling/listening).
   * Called once at daemon startup. Must resolve when the transport is ready
   * to send and receive messages.
   */
  start(): Promise<void>;

  /**
   * Graceful shutdown. Stop polling/listening, close connections.
   * Called once at daemon shutdown. Must resolve when cleanup is complete.
   */
  stop(): Promise<void>;

  // ── Outbound ────────────────────────────────────────────────────

  /**
   * Send a new message in the given thread.
   * Returns a MessageRef that can be passed to editMessage() (if supported).
   *
   * @param ctx  - Thread/channel context to send into.
   * @param text - Raw text content. The adapter applies its own formatting
   *               via formatForTransport() internally if needed.
   */
  sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef>;

  /**
   * Edit a previously sent message. No-op and returns false if the transport
   * does not support edits (supportsMessageEdit = false) or if the edit fails.
   *
   * Core MUST check capabilities.supportsMessageEdit before calling.
   *
   * @param ctx  - Thread/channel context (for rate-limiting / API scoping).
   * @param ref  - MessageRef returned by a prior sendMessage().
   * @param text - New text content (replaces the entire message body).
   */
  editMessage(ctx: ChannelContext, ref: MessageRef, text: string): Promise<boolean>;

  // ── Formatting (transport-owned) ────────────────────────────────

  /**
   * Convert raw text into the transport's native format
   * (MarkdownV2, HTML, Adaptive Card JSON, etc.).
   *
   * Called INTERNALLY by the adapter inside sendMessage()/editMessage() —
   * the core relay passes raw text and never calls this method directly.
   * Adapters without rich formatting may return the input unchanged.
   */
  formatForTransport(markdown: string): string;

  /**
   * Split a message into transport-safe chunks that each fit within
   * maxMessageLength. Returns an array of chunks in order.
   *
   * @param text   - Full text to split.
   * @param footer - Optional HUD footer appended to the last chunk.
   */
  splitMessage(text: string, footer?: string): string[];

  // ── Interactive Prompts ─────────────────────────────────────────

  /**
   * Prompt the user with a question and a set of options.
   *
   * When supportsInteractivePrompts is true, the adapter renders platform-
   * native interactive elements (inline keyboards, Adaptive Card actions,
   * Block Kit buttons). When false, the adapter falls back to a text-based
   * prompt and waits for a matching text reply.
   *
   * Returns the `value` field of the selected PromptOption, or a raw text
   * response if interactive prompts are not supported.
   *
   * @param ctx      - Thread/channel context.
   * @param question - The prompt question text.
   * @param options  - Available choices.
   * @param signal   - Optional AbortSignal; when fired the prompt resolves
   *                   with an empty string (aborted). Used for session
   *                   disconnect / idle eviction (ADR-9).
   */
  promptUser(
    ctx: ChannelContext,
    question: string,
    options: readonly PromptOption[],
    signal?: AbortSignal,
  ): Promise<string>;

  // ── Thread Management ───────────────────────────────────────────

  /**
   * Create a new thread/topic in the channel.
   *
   * Only callable when capabilities.supportsThreadCreation is true.
   * Core MUST check the capability before calling.
   *
   * @param channelId - The channel to create the thread in.
   * @param title     - Human-readable thread title / topic name.
   * @returns A ChannelContext for the newly created thread.
   */
  createThread(channelId: string, title: string): Promise<ChannelContext>;

  // ── Inbound ─────────────────────────────────────────────────────

  /**
   * Register a handler for inbound text messages (non-command).
   * The adapter calls this handler for every user message in a thread.
   * Multiple calls replace the previous handler (single handler model).
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Register a handler for a specific slash command (e.g., 'new', 'list').
   * The adapter parses the command prefix and dispatches to the matching
   * handler. Commands not registered are ignored or passed through as
   * regular messages (adapter decides; Telegram pass-through is documented
   * in src/bot/commands.ts Phase 9 rationale).
   *
   * @param command - Command name without the leading slash (e.g., 'new').
   * @param handler - Called with the ChannelContext and the args string.
   */
  onCommand(command: string, handler: CommandHandler): void;
}
