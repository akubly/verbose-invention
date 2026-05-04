# Kat — History (Summarized 2026-05-02)

## Identity & Role

- **Agent:** Kat (Bot Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Bot wiring, UX, Telegram command surface, message formatting
- **Joined:** 2026-04-12

## Key Accomplishments

### Phase 1–4 (2026-04-12 → 2026-05-01)

- Implemented `/new <name>`, `/list`, `/remove` command stack
- Fixed registry crash-safety (atomic `.tmp` → rename pattern)
- Added schema versioning (version: 1)
- Implemented session registry with duplicate-name tracking
- Built message relay handler (catch-all topic → session)
- Fixed chatId fallback guard
- Implemented `/resume <name>` command
- Fixed unit test surface (registry fixtures, mocks)

### PR #5 Cycle 4 (2026-05-03) — Production Bug Fixes

- **H-A (Relay cache rekey):** `Relay.activeSessions` was still keyed by the old topic ID after `/resume` moved the registry entry. Added `rekeySession(fromTopicId, toTopicId): void` to `Relay` that pops the cache entry at `fromTopicId`, inserts it at `toTopicId`, and cancels the stale idle timer (whose closure referenced the old key). `/resume` handler now calls `relay.rekeySession(oldTopicId, topicId)` immediately after a successful `registry.move()`. Preserves unflushed in-memory state; no factory call on next message.
- **H-B (Registry write-first):** `move()` mutated `this.entries` before `await persist()`, letting concurrent reads observe uncommitted state. Replaced the mutate-then-rollback pattern with write-first: build a snapshot `Map`, call `persistSnapshot(snapshot)` (new private method queued via `writeQueue`), only then mutate `this.entries`. On failure, `this.entries` is never touched — no rollback needed. Extracted `doPersistEntries(entries)` shared by both `doPersist()` and `persistSnapshot()`.
- **Tests:** +7 new tests: `relay.test.ts` (3 — rekeySession happy path, no-op, old topic evicted), `resume.test.ts` (2 — rekeySession called on success, not called on failure), `registry.test.ts` (2 — write-first no mutation on failure, entries untouched during persist). Existing rollback test updated to spy on `doPersistEntries` and reflect write-first semantics. 267 → 274 passing; tsc and lint clean.



- **F-B (`findAllByName` + /resume duplicate guard):** Added `findAllByName(name): SessionEntry[]` to `ISessionRegistry` and `SessionRegistry`. `/resume` now calls `findAllByName`; if >1 match (legacy on-disk duplicates), refuses with a list showing all matching `topic #N (chatId C)` entries and instructs user to `/rename` or `/remove`. `findByName` kept for callers (like `/new`) that want first-match. 
- **F-C (`move()` atomic destination check):** Added destination-unbound guard at the top of `move()` — before any in-memory mutation — throwing `Destination topic N is already bound to "name"` if bound. Eliminates the TOCTOU window between `/resume`'s UX pre-check and the actual mutation. `/resume` catch block now detects `already bound to` in the error message and emits a clean ⚠️ (not the generic "Failed to resume") telling the user to `/remove` first.
- **Tests:** 10 new tests added across `registry.test.ts` (move destination-bound, findAllByName) and `resume.test.ts` (legacy duplicate refusal, clean error surfacing). All 245 + new tests pass; tsc and lint clean.


- **F2 (Name Uniqueness):** Enforce at registration via `SessionRegistry.register()` guard. Pre-existing on-disk duplicates preserved with warning.
- **F3 (Atomic Move):** Implemented `move(fromTopicId, toTopicId, sessionName, chatId, model?)` primitive with single `persist()` call and rollback guarantee on failure.

### PR #5 Cycle 5 (2026-05-03) — Registry Full-Transaction Serialization

- **I-A (mutationQueue):** The H-B write-first fix still had an await yield between `persistSnapshot()` and the `this.entries.delete/set` mutations. A concurrent `register()` or `remove()` could mutate `this.entries` during that yield; the move would then apply stale state on top, silently clobbering the concurrent change. Fixed by generalising `writeQueue` into a `mutationQueue` (`Promise<unknown>`) and adding `enqueueMutation<T>(op: () => Promise<T>)` that serialises the entire read→compute→persist→swap transaction. `register()`, `remove()`, and `move()` all go through `enqueueMutation`. Final in-memory update is `this.entries = newEntries` (atomic reference swap) — readers always see a fully-committed state. Removed now-dead `persist()`, `persistSnapshot()`, and `doPersist()` helpers; `doPersistEntries()` is the sole disk-write path.
- **I-C (JSDoc):** Updated `move()` JSDoc on `ISessionRegistry` to describe the new contract: serialised via mutation queue, builds snapshot, persists, atomic-swaps `this.entries`, no rollback path, throws on missing source / bound dest / persist failure.
- **Tests:** +3 new tests in `registry.test.ts`: (a) move() vs concurrent register() — execution log asserts serialisation order; (b) move() vs concurrent remove() — same; (c) atomic swap — spy captures state at persist time to prove the old map is still live before the swap, list() confirms complete new state after. 274 → 278 passing; tsc and lint clean.



- **Files:** `src/bot/index.ts`, `src/bot/handlers.ts`, `src/sessions/registry.ts`
- **Test coverage:** 245 tests pass; registry module at full coverage
- **Active commands:** `/new`, `/list`, `/remove`, `/resume`, catch-all relay
- **Constraints:** Layering clean (no relay imports in bot); atomic operations verified

## Phase 6+ Roadmap

- HUD footer with repo/branch/model metadata
- Two-tier permissions (auto-approve safe, prompt destructive)
- Session export to Markdown
- MarkdownV2 parse_mode handling (Carter owns relay escaping)

## Learnings

- Registry needs both atomic writes and post-load duplicate tolerance for backward compatibility
- Single-purpose command semantics demand unique session names (no disambiguation prompts)
- Move() primitive critical for session transfer UX (vs two-step remove+register race)
