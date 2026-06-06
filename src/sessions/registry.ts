import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEntry } from '../types.js';

export type { SessionEntry } from '../types.js';

interface RegistryData {
  version?: number;  // absent in legacy files, 1 in current format
  entries: Record<string, unknown>;
}

export interface ISessionRegistry {
  load(): Promise<void>;
  register(threadId: string, channelId: string, sessionName: string, model?: string, cwd?: string): Promise<void>;
  /** Upserts an AFK-managed entry; if the session name moved threads, replaces the prior thread binding. */
  upsert(entry: SessionEntry): Promise<void>;
  /** Resolves a thread ID to its session entry. */
  resolve(threadId: string): SessionEntry | undefined;
  /** Returns every entry whose sessionName matches (normally at most one). */
  findAllByName(sessionName: string): SessionEntry[];
  findByName(sessionName: string): SessionEntry | undefined;
  list(): SessionEntry[];
  remove(threadId: string): Promise<boolean>;
  /**
   * Re-binds a named session from one thread to another.
   * Serialized via the internal mutation queue — only one registry mutation runs at a time.
   * Reads identity (sessionName, channelId, model) from the stored source entry;
   * the caller supplies only the two thread IDs.
   * Builds a new entries snapshot, persists it to disk, then atomically swaps
   * this.entries to the new map. No rollback path — this.entries is never mutated on failure.
   * Throws if fromThreadId is not registered, toThreadId is already bound, or persist fails.
   */
  move(fromThreadId: string, toThreadId: string): Promise<void>;
}

/**
 * Coerce a raw value read from legacy JSON to a string ID.
 * Numeric values (legacy topicId/chatId) are converted via String(); strings pass through.
 * Returns undefined for null/undefined/other non-coercible types.
 */
function coerceId(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
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
    typeof entry.threadId !== 'string' ||
    typeof entry.channelId !== 'string' ||
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
  if (entry.lastTopicId !== undefined && typeof entry.lastTopicId !== 'string') {
    console.warn(`[registry] Stripping invalid lastTopicId for ${label}`);
    delete entry.lastTopicId;
  }
  return true;
}

/**
 * Durable map of thread ID → Copilot session entry.
 * Persists to a JSON file so registry survives daemon restarts.
 * Active SDK session handles are NOT persisted — recreated via resumeSession on demand.
 *
 * Back-compat: legacy registry.json files store `topicId: number` and `chatId: number`.
 * On load(), numeric values are coerced to strings so existing installs upgrade
 * transparently without any migration step. The file is rewritten with string keys
 * on the next mutation (register/upsert/remove/move).
 */
export class SessionRegistry implements ISessionRegistry {
  private entries = new Map<string, SessionEntry>();
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
      for (const [key, rawValue] of Object.entries(entries)) {
        if (rawValue === null || typeof rawValue !== 'object') continue;
        const raw = rawValue as Record<string, unknown>;

        // Back-compat migration: legacy files store topicId (number) and chatId (number).
        // Coerce to threadId/channelId strings on read so existing installs upgrade transparently.
        const entry: SessionEntry = {
          sessionName: raw['sessionName'] as string,
          threadId: coerceId(raw['threadId'] ?? raw['topicId']) ?? '',
          channelId: coerceId(raw['channelId'] ?? raw['chatId']) ?? '',
          createdAt: raw['createdAt'] as string,
          cwd: (raw['cwd'] as string) ?? '',
          ...(raw['model'] !== undefined && { model: raw['model'] as string }),
          ...(raw['mode'] !== undefined && { mode: raw['mode'] as 'afk' | 'back' }),
          ...(raw['afkSince'] !== undefined && { afkSince: raw['afkSince'] as string }),
          ...(raw['lastTopicId'] !== undefined && { lastTopicId: coerceId(raw['lastTopicId']) ?? '' }),
        };

        if (!validateEntry(entry, `key ${key}`)) continue;

        // Canonical key is the threadId string; legacy numeric keys are transparently migrated.
        const canonicalKey = entry.threadId;
        if (canonicalKey !== key && String(Number(key)) !== key) {
          // String key mismatch that isn't a legacy numeric key — skip with warning.
          console.warn(`[registry] Skipping entry for key ${key}: key does not match threadId ${entry.threadId}`);
          continue;
        }

        this.entries.set(canonicalKey, entry);
      }
      // Detect duplicate names (warn but preserve — may predate uniqueness enforcement)
      const namesSeen = new Map<string, string>();
      for (const [threadId, entry] of this.entries) {
        const prev = namesSeen.get(entry.sessionName);
        if (prev !== undefined) {
          console.warn(
            `[registry] Duplicate session name "${entry.sessionName}" found for threads ${prev} and ${threadId}. New registrations with this name will be rejected.`,
          );
        } else {
          namesSeen.set(entry.sessionName, threadId);
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

  async register(threadId: string, channelId: string, sessionName: string, model?: string, cwd = process.cwd()): Promise<void> {
    return this.enqueueMutation(async () => {
      const duplicate = this.findByName(sessionName);
      if (duplicate && duplicate.threadId !== threadId) {
        throw new Error(
          `Session name "${sessionName}" is already in use by topic ${duplicate.threadId}. Choose a different name or /remove the other session first.`,
        );
      }
      const entry: SessionEntry = {
        sessionName,
        threadId,
        channelId,
        createdAt: new Date().toISOString(),
        cwd,
        ...(model !== undefined && { model }),
      };
      const newEntries = new Map(this.entries);
      newEntries.set(threadId, entry);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Registered thread ${threadId} → "${sessionName}"`);
    });
  }

  /** Upserts an AFK-managed entry, replacing any prior thread binding for the same session name. */
  async upsert(entry: SessionEntry): Promise<void> {
    return this.enqueueMutation(async () => {
      const entryToStore = { ...entry };
      if (!validateEntry(entryToStore, `session "${entry.sessionName}" thread ${entry.threadId}`)) {
        throw new Error(`[registry] Cannot upsert invalid entry for "${entry.sessionName}"`);
      }
      const duplicate = this.findByName(entryToStore.sessionName);
      const newEntries = new Map(this.entries);
      if (duplicate && duplicate.threadId !== entryToStore.threadId) {
        newEntries.delete(duplicate.threadId);
      }
      newEntries.set(entryToStore.threadId, entryToStore);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Upserted thread ${entryToStore.threadId} → "${entryToStore.sessionName}"`);
    });
  }

  resolve(threadId: string): SessionEntry | undefined {
    return this.entries.get(threadId);
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

  async remove(threadId: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      if (!this.entries.has(threadId)) return false;
      const newEntries = new Map(this.entries);
      newEntries.delete(threadId);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Removed thread ${threadId}`);
      return true;
    });
  }

  async move(fromThreadId: string, toThreadId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const source = this.entries.get(fromThreadId);
      if (!source) {
        throw new Error(`No session found for topic ${fromThreadId}`);
      }
      if (this.entries.has(toThreadId)) {
        throw new Error(`Destination topic ${toThreadId} is already bound to "${this.entries.get(toThreadId)!.sessionName}"`);
      }
      const newEntry: SessionEntry = { ...source, threadId: toThreadId };
      const newEntries = new Map(this.entries);
      newEntries.delete(fromThreadId);
      newEntries.set(toThreadId, newEntry);
      await this.doPersistEntries(newEntries);
      this.entries = newEntries;
      console.log(`[registry] Moved "${source.sessionName}" from thread ${fromThreadId} to thread ${toThreadId}`);
    });
  }

  private async doPersistEntries(entries: Map<string, SessionEntry>): Promise<void> {
    const data: RegistryData = { version: 1, entries: Object.fromEntries(entries) };
    await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
    const tmp = this.persistPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, this.persistPath);
  }
}
