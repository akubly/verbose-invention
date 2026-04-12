import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEntry } from '../types.js';

export type { SessionEntry } from '../types.js';

interface RegistryData {
  version: 1;
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
      if (data.version !== undefined && data.version !== 1) {
        console.warn(`[registry] Unsupported registry version ${data.version} at ${this.persistPath}, expected 1. Starting empty.`);
        return;
      }
      for (const [key, value] of Object.entries(data.entries)) {
        this.entries.set(Number(key), value);
      }
      console.log(`[registry] Loaded ${this.entries.size} session(s) from ${this.persistPath}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // first run
      if (err instanceof SyntaxError) {
        console.warn(`[registry] Corrupt registry at ${this.persistPath}, backing up and starting fresh`);
        await fs.rename(this.persistPath, this.persistPath + '.corrupt.' + Date.now());
        return;
      }
      throw err;
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
    const data: RegistryData = { version: 1, entries: Object.fromEntries(this.entries) };
    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    const tmp = this.persistPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, this.persistPath);
  }
}
