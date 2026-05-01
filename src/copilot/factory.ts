/**
 * CopilotSession / CopilotSessionFactory interfaces for Reach.
 *
 * Noble Six: implement CopilotSessionFactory against the real @github/copilot-sdk
 * and wire it into src/main.ts. The stub below exists for local dev only.
 */

export interface CopilotSession {
  send(message: string): AsyncIterable<string>;
}

export type PermissionPromptCallback = (toolName: string, args: string) => Promise<boolean>;

export interface CopilotSessionFactory {
  /**
   * Try to resume an existing session by name.
   * Returns null if no prior session exists — caller should then call create().
   */
  resume(
    sessionName: string,
    model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession | null>;
  /** Create a new session with the given name. */
  create(
    sessionName: string,
    model?: string,
    permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession>;
  /** Optional — called by relay on SDK errors to force restart on next call. */
  resetForRestart?(): void;
}

/**
 * Stub that throws — replace with real binding from @github/copilot-sdk.
 */
export class StubCopilotSessionFactory implements CopilotSessionFactory {
  async resume(
    _sessionName: string,
    _model?: string,
    _permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession | null> {
    void _sessionName;
    void _model;
    void _permissionCallback;
    return null; // Stub: no sessions exist, always falls through to create()
  }

  async create(
    _sessionName: string,
    _model?: string,
    _permissionCallback?: PermissionPromptCallback,
  ): Promise<CopilotSession> {
    void _sessionName;
    void _model;
    void _permissionCallback;
    throw new Error('StubCopilotSessionFactory: wire in @github/copilot-sdk');
  }
}
