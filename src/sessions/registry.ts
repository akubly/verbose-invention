import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEntry } from '../types.js';

export type { SessionEntry } from '../types.js';

interface RegistryData {
  version?: number;  // absent in legacy files, 1 in current format
  entries: Record<string, SessionEntry>;
}

export interface ISessionRegistry {
  load(): Promise<void>;
  register(topicId: number, chatId: number, sessionName: string, model?: string): Promise<void>;
  resolve(telegramTopicId: number): SessionEntry | undefined;
  findByName(sessionName: string): SessionEntry | undefined;
  /** Returns every entry whose sessionName matches — may be >1 when legacy duplicates exist on disk. */
  findAllByName(sessionName: string): SessionEntry[];
  list(): SessionEntry[];
  remove(telegramTopicId: number): Promise<boolean>;
  /**
   * Atomically re-binds a named session from one topic to another.
   * Reads identity (sessionName, chatId, model) from the stored source entry —
   * the caller supplies only the two topic IDs.
   * Verifies that toTopicId is unbound before any mutation, then mutates both
   * Map entries in memory and calls persist() exactly once.
   * Throws if fromTopicId is not registered or toTopicId is already bound (TOCTOU-safe).
   * If persist() throws, the in-memory state is rolled back.
   */
  move(fromTopicId: number, toTopicId: number): Promise<void>;
}

/**
 * Durable map of Telegram forum topic ID → Copilot session entry.
 * Persists to a JSON file so registry survives daemon restarts.
 * Active SDK session handles are NOT persisted — recreated via resumeSession on demand.
 */
export class SessionRegistry implements ISessionRegistry {
  private entries = new Map<number, SessionEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistPath: string) {}

  async load(): Promise<void> {
    this.entries.clear();
    try {
      const raw = await fs.readFile(this.persistPath, 'utf-8');
      const data: RegistryData = JSON.parse(raw);
      if (data.version !== undefined && data.version !== 1) {
        console.warn(`[registry] Unsupported registry version ${data.version} at ${this.persistPath}, expected 1. Starting empty.`);
        this.entries.clear();
        return;
      }
      const entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
      if (!data.entries) {
        console.warn(`[registry] Registry file missing 'entries' field, starting empty`);
      }
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value.sessionName !== 'string' || typeof value.topicId !== 'number' || typeof value.chatId !== 'number' || typeof value.createdAt !== 'string') {
          console.warn(`[registry] Skipping invalid entry for key ${key}`);
          continue;
        }
        if (Number(key) !== value.topicId) {
          console.warn(`[registry] Skipping entry for key ${key}: key does not match topicId ${value.topicId}`);
          continue;
        }
        // Strip invalid model field (must be string if present)
        if (value.model !== undefined && typeof value.model !== 'string') {
          console.warn(`[registry] Stripping invalid model for key ${key}`);
          delete value.model;
        }
        this.entries.set(Number(key), value);
      }
      // Detect duplicate names (warn but preserve — may predate uniqueness enforcement)
      const namesSeen = new Map<string, number>();
      for (const [topicId, entry] of this.entries) {
        const prev = namesSeen.get(entry.sessionName);
        if (prev !== undefined) {
          console.warn(
            `[registry] Duplicate session name "${entry.sessionName}" found for topics ${prev} and ${topicId}. New registrations with this name will be rejected.`,
          );
        } else {
          namesSeen.set(entry.sessionName, topicId);
        }
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

  async register(topicId: number, chatId: number, sessionName: string, model?: string): Promise<void> {
    // Enforce name uniqueness across different topics
    const duplicate = this.findByName(sessionName);
    if (duplicate && duplicate.topicId !== topicId) {
      throw new Error(
        `Session name "${sessionName}" is already in use by topic ${duplicate.topicId}. Choose a different name or /remove the other session first.`,
      );
    }
    const entry: SessionEntry = {
      sessionName,
      topicId,
      chatId,
      createdAt: new Date().toISOString(),
      ...(model !== undefined && { model }),
    };
    this.entries.set(topicId, entry);
    await this.persist();
    console.log(`[registry] Registered topic ${topicId} → "${sessionName}"`);
  }

  resolve(telegramTopicId: number): SessionEntry | undefined {
    return this.entries.get(telegramTopicId);
  }

  findByName(sessionName: string): SessionEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.sessionName === sessionName) return entry;
    }
    return undefined;
  }

  findAllByName(sessionName: string): SessionEntry[] {
    const result: SessionEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.sessionName === sessionName) result.push(entry);
    }
    return result;
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

  async move(fromTopicId: number, toTopicId: number): Promise<void> {
    const oldEntry = this.entries.get(fromTopicId);
    if (!oldEntry) {
      throw new Error(`No session found for topic ${fromTopicId}`);
    }
    // F-C: atomic destination-unbound check — eliminates TOCTOU window where a
    // concurrent /new or /resume could bind the destination between the caller's
    // pre-check and this mutation.
    const destEntry = this.entries.get(toTopicId);
    if (destEntry) {
      throw new Error(`Destination topic ${toTopicId} is already bound to "${destEntry.sessionName}"`);
    }
    // Identity is read from the stored source entry — caller cannot rename or
    // change chatId/model by passing different args.
    const newEntry: SessionEntry = {
      ...oldEntry,
      topicId: toTopicId,
    };
    // Write-first: build the new map snapshot and persist it before touching
    // this.entries.  If the write fails, this.entries is never mutated, so
    // concurrent reads cannot observe uncommitted state and no rollback is needed.
    const snapshot = new Map(this.entries);
    snapshot.delete(fromTopicId);
    snapshot.set(toTopicId, newEntry);
    await this.persistSnapshot(snapshot);
    // Persist succeeded — safe to update the live map.
    this.entries.delete(fromTopicId);
    this.entries.set(toTopicId, newEntry);
    console.log(`[registry] Moved "${oldEntry.sessionName}" from topic ${fromTopicId} to topic ${toTopicId}`);
  }

  private persist(): Promise<void> {
    const op = this.writeQueue.then(() => this.doPersist());
    // Queue always advances — swallow errors for continuation only
    this.writeQueue = op.catch(() => {});
    // But return the actual operation so callers see errors
    return op;
  }

  /**
   * Enqueues a write of an explicit snapshot map (used by move() for write-first
   * semantics — persists the desired end-state before mutating this.entries).
   */
  private persistSnapshot(snapshot: Map<number, SessionEntry>): Promise<void> {
    const op = this.writeQueue.then(() => this.doPersistEntries(snapshot));
    this.writeQueue = op.catch(() => {});
    return op;
  }

  private async doPersist(): Promise<void> {
    await this.doPersistEntries(this.entries);
  }

  private async doPersistEntries(entries: Map<number, SessionEntry>): Promise<void> {
    const data: RegistryData = { version: 1, entries: Object.fromEntries(entries) };
    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    const tmp = this.persistPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, this.persistPath);
  }
}
