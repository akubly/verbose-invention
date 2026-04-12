/**
 * Shared domain types for Reach.
 *
 * Noble Six: validate the CopilotClient/CopilotSession shape against the real
 * @github/copilot-sdk API — these are best-guess interfaces written for TDD.
 */

export interface SessionEntry {
  /** Human-readable name used in /new and registry lookups. */
  name: string;
  /** Telegram forum topic ID that maps to this session. */
  telegramTopicId: number;
  /** Opaque session ID returned by the Copilot SDK on createSession. */
  copilotSessionId: string;
  /** Absolute path to the repo that scopes this Copilot session. */
  repoPath?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** A single chunk yielded by CopilotSession.send(). */
export interface CopilotChunk {
  text: string;
}

/** An active Copilot session handle. */
export interface CopilotSession {
  id: string;
  send(message: string): AsyncIterable<CopilotChunk>;
}

/** Top-level SDK client surface used by Reach. */
export interface CopilotClient {
  createSession(options: { name: string; repoPath?: string }): Promise<CopilotSession>;
  resumeSession(sessionId: string): Promise<CopilotSession>;
}
