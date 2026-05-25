import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEntry } from '../types.js';

export type { SessionEntry } from '../types.js';

interface RegistryData {
  version?: number;  // absent in legacy files, 1 in current format
  entries: Record<string, SessionEntry>;
}

/**
 * Query-extended surface of the session registry.
 * Separates the lookup methods from the mutation surface so callers can declare
 * exactly what they need.  `SessionRegistry` always implements both interfaces.
 */
export interface IRegistryQuery {
  /** Resolves a Telegram topic ID to its session entry. */
  resolve(telegramTopicId: number): SessionEntry | undefined;
  /** Returns every entry whose sessionName matches (normally at most one). */
  findAllByName(sessionName: string): SessionEntry[];
}

export interface ISessionRegistry extends IRegistryQuery {
  load(): Promise<void>;
  register(topicId: number, chatId: number, sessionName: string, model?: string, cwd?: string): Promise<void>;
  /** Upserts an AFK-managed entry; if the session name moved topics, replaces the prior topic binding. */
  upsert(entry: SessionEntry): Promise<void>;
  findByName(sessionName: string): SessionEntry | undefined;
  list(): SessionEntry[];
  remove(telegramTopicId: number): Promise<boolean>;
  /**
   * Re-binds a named session from one topic to another.
   * Serialized via the internal mutation queue — only one registry mutation runs at a time.
   * Reads identity (sessionName, chatId, model) from the stored source entry;
   * the caller supplies only the two topic IDs.
   * Builds a new entries snapshot, persists it to disk, then atomically swaps
   * this.entries to the new map. No rollback path — this.entries is never mutated on failure.
   * Throws if fromTopicId is not registered, toTopicId is already bound, or persist fails.
   */
  move(fromTopicId: number, toTopicId: number): Promise<void>;
}

/**
 * Normalises and validates the optional fields on a SessionEntry in place.
 * Called from both load() and upsert() to keep validation symmetric.
 * Returns false if required fields are missing or of the wrong type (caller
 * should skip or reject the entry); returns true when all fields are valid.
 */
function validateEntry(entry: SessionEntry, label: string): boolean {
  if (
    typeof entry.sessionName !== 'string' ||
    typeof entry.topicId !== 'number' ||
    typeof entry.chatId !== 'number' ||
    typeof entry.createdAt !== 'string'
  ) {
    console.warn(`[registry] Invalid required fields for ${label}`);
    return false;
  }
  if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) {
    console.warn(`[registry] Entry ${label} missing cwd; defaulting to daemon cwd`);
    entry.cwd = process.cwd();
  }
  if (entry.model !== undefined && typeof entry.model !== 'string') {
    console.warn(`[registry] Stripping invalid model for ${label}`);
    delete entry.model;
  }
  if (entry.mode !== undefined && entry.mode !== 'afk' && entry.mode !== 'back') {
    console.warn(`[registry] Stripping invalid mode for ${label}`);
    delete entry.mode;
  }
  if (entry.afkSince !== undefined && typeof entry.afkSince !== 'string') {
    console.warn(`[registry] Stripping invalid afkSince for ${label}`);
    delete entry.afkSince;
  }
  if (entry.lastTopicId !== undefined && typeof entry.lastTopicId !== 'number') {
    console.warn(`[registry] Stripping invalid lastTopicId for ${label}`);
    delete entry.lastTopicId;
  }
  return true;
}

/**
 * Durable map of Telegram forum topic ID → Copilot session entry.
 * Persists to a JSON file so registry survives daemon restarts.
 * Active SDK session handles are NOT persisted — recreated via resumeSession on demand.
 */
export class SessionRegistry implements ISessionRegistry {
  private entries = new Map<number, SessionEntry>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly persistPath: string) {}

  private enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(op, op);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

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
        if (!validateEntry(value, `key ${key}`)) continue;
        if (Number(key) !== value.topicId) {
          console.warn(`[registry] Skipping entry for key ${key}: key does not match topicId ${value.topicId}`);
          continue;
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

  async register(topicId: number, chatId: number, sessionName: string, model?: string, cwd = process.cwd()): Promise<void> {
    return this.enqueueMutation(async () => {
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
        cwd,
        ...(model !== undefined && { model }),
      };
      const newEntries = new Map(this.entries);
      newEntries.set(topicId, entry);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Registered topic ${topicId} → "${sessionName}"`);
    });
  }

  /** Upserts an AFK-managed entry, replacing any prior topic binding for the same session name. */
  async upsert(entry: SessionEntry): Promise<void> {
    return this.enqueueMutation(async () => {
      const entryToStore = { ...entry };
      if (!validateEntry(entryToStore, `session "${entry.sessionName}" topic ${entry.topicId}`)) {
        throw new Error(`[registry] Cannot upsert invalid entry for "${entry.sessionName}"`);
      }
      const duplicate = this.findByName(entryToStore.sessionName);
      const newEntries = new Map(this.entries);
      if (duplicate && duplicate.topicId !== entryToStore.topicId) {
        newEntries.delete(duplicate.topicId);
      }
      newEntries.set(entryToStore.topicId, entryToStore);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Upserted topic ${entryToStore.topicId} → "${entryToStore.sessionName}"`);
    });
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
    return this.enqueueMutation(async () => {
      if (!this.entries.has(telegramTopicId)) return false;
      const newEntries = new Map(this.entries);
      newEntries.delete(telegramTopicId);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Removed topic ${telegramTopicId}`);
      return true;
    });
  }

  async move(fromTopicId: number, toTopicId: number): Promise<void> {
    return this.enqueueMutation(async () => {
      const source = this.entries.get(fromTopicId);
      if (!source) {
        throw new Error(`No session found for topic ${fromTopicId}`);
      }
      if (this.entries.has(toTopicId)) {
        throw new Error(`Destination topic ${toTopicId} is already bound to "${this.entries.get(toTopicId)!.sessionName}"`);
      }
      const newEntry: SessionEntry = { ...source, topicId: toTopicId };
      const newEntries = new Map(this.entries);
      newEntries.delete(fromTopicId);
      newEntries.set(toTopicId, newEntry);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Moved "${source.sessionName}" from topic ${fromTopicId} to topic ${toTopicId}`);
    });
  }

  private async doPersistEntries(entries: Map<number, SessionEntry>): Promise<void> {
    const data: RegistryData = { version: 1, entries: Object.fromEntries(entries) };
    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    const tmp = this.persistPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, this.persistPath);
  }
}
