/**
 * Shared domain types for Reach.
 */

export interface SessionEntry {
  /** Human-readable session name set by /new or the CLI extension. */
  sessionName: string;
  /** Telegram forum topic ID that maps to this session. */
  topicId: number;
  /** Telegram supergroup chat ID. */
  chatId: number;
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
  /** Most recent AFK topic ID, retained for topic reuse. */
  lastTopicId?: number;
}
