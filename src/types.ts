/**
 * Shared domain types for Reach.
 */

export interface SessionEntry {
  /** Human-readable session name set by /new or the CLI extension. */
  sessionName: string;
  /**
   * Opaque thread/topic identifier (stringified).
   * For Telegram this is the forum topic ID converted to string.
   * Legacy JSON files store this as numeric `topicId`; registry.load() coerces on read.
   */
  threadId: string;
  /**
   * Opaque channel/chat identifier (stringified).
   * For Telegram this is the supergroup chat ID converted to string.
   * Legacy JSON files store this as numeric `chatId`; registry.load() coerces on read.
   */
  channelId: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Working directory for disambiguation and future spawn/resume flows. */
  cwd: string;
  /** Per-session model override (falls back to global REACH_MODEL). */
  model?: string;
  /** Reflection of daemon-wide AFK mode for this entry. */
  mode?: 'afk' | 'back';
  /** ISO-8601 timestamp when this entry entered AFK mode. */
  afkSince?: string;
  /** Most recent AFK thread ID (stringified), retained for topic reuse. */
  lastTopicId?: string;
}
