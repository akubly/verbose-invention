import type { CopilotClient, CopilotSession } from '../types.js';

/**
 * Stub CopilotClient — throws "not implemented" until Noble Six wires in the
 * real @github/copilot-sdk binding. Inject this at the DI root (src/main.ts)
 * only for local development/testing; swap for the real implementation in prod.
 */
export class StubCopilotClient implements CopilotClient {
  async createSession(_options: { name: string; repoPath?: string }): Promise<CopilotSession> {
    throw new Error('StubCopilotClient: wire in @github/copilot-sdk');
  }

  async resumeSession(_sessionId: string): Promise<CopilotSession> {
    throw new Error('StubCopilotClient: wire in @github/copilot-sdk');
  }
}
