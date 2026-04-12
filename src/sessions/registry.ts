import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEntry } from '../types.js';

export type { SessionEntry } from '../types.js';

interface RegistryData {
  entries: Record<string, SessionEntry>;
}

export interface ISessionRegistry {
  load(): Promise<void>;
  register(topicId: number, chatId: number, sessionName: string): Promise<void>;
  resolve(telegramTopicId: number): SessionEntry | undefined;
  list(): SessionEntry[];
  remove(telegramTopicId: number): Promise<boolean>;
}

/**
 * Durable map of Telegram forum topic ID → Copilot session entry.
 * Persists to a JSON file so registry survives daemon restarts.
 * Active SDK session handles are NOT persisted — recreated via resumeSession on demand.
 */
export class SessionRegistry implements ISessionRegistry {
  private entries = new Map<number, SessionEntry>();

  constructor(private readonly persistPath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf-8');
      const data: RegistryData = JSON.parse(raw);
      for (const [key, value] of Object.entries(data.entries)) {
        this.entries.set(Number(key), value);
      }
      console.log(`[registry] Loaded ${this.entries.size} session(s) from ${this.persistPath}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // First run — no registry file yet, start empty
    }
  }

  async register(topicId: number, chatId: number, sessionName: string): Promise<void> {
    const entry: SessionEntry = {
      sessionName,
      topicId,
      chatId,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(topicId, entry);
    await this.persist();
    console.log(`[registry] Registered topic ${topicId} → "${sessionName}"`);
  }

  resolve(telegramTopicId: number): SessionEntry | undefined {
    return this.entries.get(telegramTopicId);
  }

  list(): SessionEntry[] {
    return Array.from(this.entries.values());
  }

  async remove(telegramTopicId: number): Promise<boolean> {
    const removed = this.entries.delete(telegramTopicId);
    if (removed) {
      await this.persist();
      console.log(`[registry] Removed topic ${telegramTopicId}`);
    }
    return removed;
  }

  private async persist(): Promise<void> {
    const data: RegistryData = { entries: Object.fromEntries(this.entries) };
    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    await fs.writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
