import type { CopilotSession, CopilotSessionFactory } from '../../src/copilot/factory.js';
import { vi } from 'vitest';

/**
 * Makes an async iterable that yields string chunks — mirrors what
 * a real Copilot SDK session.send() returns.
 */
export function makeStream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * Makes a mock CopilotSession whose send() yields the given chunks.
 * Pass `failAfter` to simulate a mid-stream error.
 */
export function makeMockSession(
  chunks: string[] = ['Hello', ' world'],
  failAfter?: number,
): CopilotSession {
  return {
    send: vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < chunks.length; i++) {
          if (failAfter !== undefined && i === failAfter) {
            throw new Error('Stream interrupted');
          }
          yield chunks[i];
        }
      },
    }),
  };
}

/**
 * Makes a mock CopilotSessionFactory.
 * By default both create() and resume() resolve to the same session.
 * Now accepts model parameter to match updated interface.
 */
export function makeMockFactory(sessionOverrides?: Partial<CopilotSession>): CopilotSessionFactory {
  const session = { ...makeMockSession(), ...sessionOverrides };
  return {
    create: vi.fn().mockResolvedValue(session),
    resume: vi.fn().mockResolvedValue(session),
  };
}
