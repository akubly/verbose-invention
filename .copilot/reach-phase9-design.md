# Reach Phase 9 Design — Dogfood Feedback Triage

**Date:** 2026-05-30T11:32:20-07:00  
**Author:** Noble Six (Lead / Architect)  
**Context:** Phase 8.5 shipped (install story, 570 tests, Issue #8 fixed). Aaron ran dogfood and brought back 3 items for Phase 9.

---

## TL;DR — One-Line Recommendations

| Item | Recommendation | Cost |
|------|----------------|------|
| **1. Orientation message** | Send session status on first activation per-session (not every activation). Fields: sessionId, cwd, model, mode. | S — 2–3h: one handler + one message formatter |
| **2. Slash command pass-through** | **Path B (pass-through)** — detect `/` prefix in topic handler, forward verbatim via `mirror.input`. Add `/clear` curated handling in Phase 10+ if needed. | M — 4–6h: handler fix + extension relay.command stub activation |
| **3. CWD registry** | Add `knownCwds` array to `config.json`, auto-discover on session registration, expose via `/new --cwd` arg or `/cwd list|add|remove` commands. | M-L — 8–12h: config schema, discovery, UX, persistence |

**Open Questions:** 8 items requiring Aaron's input before sprint launch (see §6).

---

## Item 1 — Orientation Message on Topic Activation

### Problem

When Aaron goes `/afk` and returns to Telegram, topics are activated but provide no context about the session state. The user is dropped into a topic with no orientation — they don't know what session is bound, where it's running, or what happened while they were away.

### Investigation Findings

**Current activation flow:**
1. `/afk` → extension sends `afk.request` → daemon activates AFK mode
2. `afkMode.ts:activate()` creates/reuses topic, posts banner: `"📡 AFK mode active — N session(s)"`
3. `session.registered` message sent to extension includes `mode.active` and `topicId`
4. Extension shows CLI message: `"🛰️ AFK mode active"` + topic URL

**What's missing:** The banner says "AFK mode active" but doesn't say **which session** or provide any session-specific context (cwd, model, recent work).

**SDK state available (from `session.d.ts` and `client.d.ts`):**
- `sessionId` — always available
- `SessionMetadata.context.cwd` — working directory
- `SessionMetadata.context.gitRoot`, `repository`, `branch` — git info
- `SessionMetadata.summary` — session summary (if CLI generates one)
- Model — available from `hello` message or session config

**Daemon-side state (from `registry.ts` + `afkMode.ts`):**
- `sessionName`, `cwd`, `model`, `chatId`, `topicId` — all in `SessionEntry`
- `mode`, `afkSince` — AFK state per entry
- Last assistant turn summary — **NOT cached**; would require SDK call to fetch

### Design

**Recommended: Session orientation message on first activation per-session.**

When a topic is activated for a session (first time in this AFK cycle):
```
📍 Session: reach-myproject
📂 CWD: D:\git\myproject
🤖 Model: claude-sonnet-4
🛰️ Mode: AFK (since 11:30)

Send a message to continue the conversation.
```

**Trigger logic:**
- Fire on `afk.activated` for each session, but only **first time** per AFK cycle (track via `orientationSent: boolean` in `TopicBinding`)
- NOT on every reconnect or topic switch
- Reset `orientationSent = false` when AFK mode deactivates (via `/back`)

**Fields included:**
| Field | Source | Cost |
|-------|--------|------|
| sessionId | `TopicBinding.sessionId` | Free |
| cwd | `SessionEntry.cwd` (registry) | Free |
| model | `SessionEntry.model` or globalModel | Free |
| mode + since | `AfkModeController.mode.since` | Free |
| last turn summary | SDK `getMessages()` → filter `assistant.message` → truncate | **Token cost** — optional, defer |

**Recommendation:** Defer "last turn summary" to Phase 10+. Token cost for SDK call + summarization is non-trivial for a one-time message. The basic context (session name, cwd, model, mode since) is sufficient for orientation.

### Location

- **New code:** `afkMode.ts` — add `sendOrientationMessage()` method, call from `ensureTopic()` after topic created/bound
- **Message format:** Plain text (not MarkdownV2) for simplicity; can upgrade later if needed
- **Protocol impact:** None — uses existing `bot.api.sendMessage()`

### Scope

- [ ] Add `orientationSent: boolean` to `TopicBinding` type
- [ ] Implement `sendOrientationMessage()` in `AfkModeController`
- [ ] Call from `ensureTopic()` when `!binding.orientationSent`
- [ ] Reset `orientationSent` for all bindings on deactivate
- [ ] Unit tests: orientation sent once, not on reconnect, reset on `/back`

**Complexity:** S (2–3 hours implementation + tests)

### Open Questions for Aaron

1. **Q1-1:** Should the orientation message include last turn summary? (Token cost + SDK call delay vs. context value)
2. **Q1-2:** Should `/status` exist as a manual command to re-fetch this info on demand? (Useful if user missed the initial message)

---

## Item 2 — Slash Command Pass-Through from Telegram → Session

### Problem

Slash commands typed in Telegram topics (e.g., `/clear`, `/agent`, `/model`) don't reach the CLI session. Aaron expected them to work like natural-language messages.

### Investigation Findings — **WHY IT DOESN'T WORK TODAY**

**Root cause identified: `afkMode.ts:151` explicitly drops slash commands.**

```typescript
// afkMode.ts:151
if (text.startsWith('/')) return false;
```

This guard exists because:
1. **Telegram bot commands** (registered via BotFather) like `/new`, `/list`, `/help` start with `/`
2. The AFK handler doesn't want to intercept bot commands — those should fall through to the regular bot handlers
3. The guard was a blanket `/` check without distinguishing "Telegram bot command" from "CLI session command"

**Additionally, `handlers.ts:270` has the same guard:**
```typescript
// handlers.ts:270
if (ctx.message.text.startsWith('/')) return;
```

This prevents non-AFK relay from forwarding slash commands too.

**The protocol envelope exists but is STUBBED:**

`extension.mjs:343-349` handles `relay.command` but just logs it:
```javascript
case 'relay.command':
  if (isForCurrentSession(msg, 'relay.command')) {
    const command = typeof msg.command === 'string' ? sanitizeForCliLine(msg.command) : '<unknown>';
    const args = Array.isArray(msg.args) ? msg.args.map(sanitizeForCliLine).join(' ') : '';
    log('info', `relay.command received (stub): ${command} ${args}`.trim());
  }
  break;
```

`protocol.ts:191-198` defines the envelope (deferred in Phase 8):
```typescript
// DEFERRED (Phase 8): no daemon producer — envelope reserved for /clear and future relay commands per ADR-11 §9.
export interface RelayCommandMessage {
  type: 'relay.command';
  sessionId: string;
  command: string;
  args: string[];
}
```

### Two Paths — Trade-off Analysis

**Path A: Skills Approach (allowlist curated commands)**

| Aspect | Assessment |
|--------|------------|
| **Concept** | Daemon intercepts `/clear`, `/agent`, `/model`; translates to specific SDK/CLI operations; provides rich Telegram UX (e.g., `/model` shows picker) |
| **Maintenance** | Each new command = new daemon code |
| **Future-proofing** | ❌ Every new CLI command needs Reach-side implementation |
| **Consistency** | Telegram UX can differ from CLI UX |
| **Complexity** | HIGH — each command has different semantics (e.g., `/clear` resets context vs. `/model` is a setter) |

**Path B: Pass-Through Approach (forward verbatim)**

| Aspect | Assessment |
|--------|------------|
| **Concept** | AFK handler detects "this `/foo` is NOT a Telegram bot command" → forwards via `mirror.input` → CLI interprets natively |
| **Maintenance** | Zero daemon code per new CLI command |
| **Future-proofing** | ✅ Any CLI command works automatically |
| **Consistency** | ✅ Same behavior as typing in CLI |
| **Complexity** | LOW — modify the `/` guard in `handleTelegramMessage()` |

**Detection for Path B:**
The daemon knows its Telegram bot commands (registered in `handlers.ts`): `/new`, `/list`, `/remove`, `/resume`, `/help`, `/pair`. Anything else that starts with `/` is a **CLI command** and should pass through.

```typescript
const BOT_COMMANDS = new Set(['new', 'list', 'remove', 'resume', 'help', 'pair']);

function isBotCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const match = text.match(/^\/([a-z_]+)/);
  return match !== null && BOT_COMMANDS.has(match[1]);
}

// In handleTelegramMessage():
if (isBotCommand(text)) return false;  // Let regular handler process
// Otherwise, forward via mirror.input...
```

### Recommendation: **Path B (Pass-Through)**

**Reasoning:**
1. **Zero maintenance burden** — new CLI commands automatically work
2. **Consistency** — user gets the same behavior as terminal
3. **Simpler implementation** — change the guard condition, done
4. **SDK has no special slash-command API** — `send({ prompt: "/clear" })` works; the CLI interprets it internally
5. **Path A is overkill** — until Reach needs Telegram-specific UX for specific commands (e.g., a model picker with inline keyboard), pass-through is sufficient

**Phase 10+ opportunity:** If specific commands need rich Telegram UX (e.g., `/model` shows interactive picker), add curated handling for those as a **hybrid** layer on top of pass-through.

### Implementation

**Changes required:**

1. **`afkMode.ts:handleTelegramMessage()`** — replace `if (text.startsWith('/')) return false;` with:
   ```typescript
   if (this.isBotCommand(text)) return false;
   ```

2. **Add helper method `isBotCommand(text: string): boolean`** in `AfkModeController`:
   ```typescript
   private static readonly BOT_COMMANDS = new Set(['new', 'list', 'remove', 'resume', 'help', 'pair']);
   
   private isBotCommand(text: string): boolean {
     if (!text.startsWith('/')) return false;
     const match = text.match(/^\/([a-z_]+)/);
     return match !== null && AfkModeController.BOT_COMMANDS.has(match[1]!);
   }
   ```

3. **`handlers.ts:270`** — same fix for non-AFK relay (or centralize via shared helper)

4. **Extension `relay.command` stub** — for Phase 9, leave the stub as-is. `mirror.input` is sufficient. `relay.command` envelope can be activated in Phase 10+ if structured command dispatch is needed.

### Scope

- [ ] Add `isBotCommand()` helper to `afkMode.ts`
- [ ] Update guard in `handleTelegramMessage()`
- [ ] Update guard in `handlers.ts` relay fallback
- [ ] Test: `/clear` in topic → reaches CLI, `/new` in topic → handled by bot
- [ ] Test: `/unknowncommand` → passed through (CLI handles gracefully)

**Complexity:** M (4–6 hours implementation + tests)

### Open Questions for Aaron

3. **Q2-1:** Should we maintain a single authoritative `BOT_COMMANDS` set in one place (e.g., handlers.ts exports it)? Or is duplication in afkMode.ts acceptable?
4. **Q2-2:** Do you want `/clear` to have special handling (e.g., confirmation prompt in Telegram before wiping session context)? Or pure pass-through is fine?

---

## Item 3 — Multi-CWD / Clone Registry for New Sessions

### Problem

Today, `/new session-name` always creates a session in the **daemon's cwd** (fixed at launch). Aaron wants to start sessions in different git repos without restarting the daemon.

### Investigation Findings

**Current behavior confirmed:**
- Daemon cwd is `process.cwd()` at launch time
- `registry.ts:138` — `register()` defaults `cwd = process.cwd()`
- `handlers.ts:/new` command doesn't accept a `--cwd` flag
- Extension sends `cwd: process.cwd()` in `hello` message — but this is the extension's cwd (the CLI's cwd), not daemon's choice

**Where cwd matters:**
1. **Session registry** — `SessionEntry.cwd` stored for disambiguation
2. **SDK session** — CLI creates session in its own cwd (extension-side); daemon doesn't control CLI cwd
3. **Future spawn-from-Telegram** — daemon would need to spawn CLI in a chosen cwd

**Key insight:** The cwd question has two facets:
- **Recording:** What cwd does Reach store for a session? (Already works via registry)
- **Controlling:** Can Reach spawn a CLI session in a chosen cwd? (NOT implemented — Telegram-initiated spawn is Phase 11+ scope)

For Phase 9, Aaron's ask is **visibility + selection UX** — when he types `/new`, he wants to see a list of known repos and pick one.

### Storage Design

**Extend `config.json`:**
```typescript
interface ReachConfig {
  telegramChatId?: number;
  telegramAllowedUserIds?: number[];
  knownCwds?: KnownCwd[];  // NEW
}

interface KnownCwd {
  path: string;           // Absolute path
  alias?: string;         // Optional friendly name (e.g., "reach", "myproject")
  addedAt: string;        // ISO-8601 timestamp
  lastUsed?: string;      // ISO-8601, updated on session creation
}
```

**Why `config.json`?**
- Already exists, crash-safe (atomic write via tmp + rename)
- User-editable (can manually add paths)
- Not session-specific (registry is per-topic-mapping)

**Path validation:**
- Must be absolute path
- Must exist on filesystem
- Recommend: must be git repo root (check for `.git/` directory)
- Traversal prevention: normalize via `path.resolve()`, reject if final path differs from input (catches `..` tricks)

### Discovery Mechanism

**Recommended: Manual + auto-capture hybrid**

| Source | Mechanism | When |
|--------|-----------|------|
| **Manual add** | `/cwd add <path>` or `/cwd add` (uses current topic's session cwd) | On demand |
| **Auto-capture** | When extension sends `hello` with a cwd not in `knownCwds`, offer to add it | Every session connect |
| **Manual list** | `/cwd list` | On demand |
| **Manual remove** | `/cwd remove <alias-or-path>` | On demand |

**NOT recommended for Phase 9:**
- Auto-scan parent directories — too slow, too many false positives
- VS Code workspace import — Windows-only, fragile registry parsing, future scope

### UX Design — `/new` with CWD Selection

**Option A: Inline argument**
```
/new my-session --cwd D:\git\myproject
/new my-session --cwd @reach   # @ prefix for alias lookup
```
Pros: Single command, scriptable
Cons: Long paths are tedious to type in Telegram

**Option B: Interactive picker**
```
> /new my-session
🗂️ Choose working directory:
[reach] D:\git\verbose-invention
[myproj] D:\git\myproject
[other] Enter path manually…
```
Uses Telegram inline keyboard. User taps one.
Pros: Better mobile UX, discoverable
Cons: More implementation complexity

**Recommendation for Phase 9:** Start with **Option A** (inline `--cwd` flag). Option B picker can be Phase 10+ enhancement.

**Fallback behavior:**
- No `--cwd` specified → use daemon's cwd (current behavior preserved)
- `--cwd` specified but path not in `knownCwds` → validate & auto-add, then use it
- `--cwd @alias` specified but alias unknown → error with suggestion

### Session Pin Behavior

**Question:** Does cwd pin at session creation, or can it change mid-session?

**Answer:** Pin at creation. The SDK session is bound to the CLI process's cwd (set when CLI spawned). Changing mid-session would require session restart.

For Phase 9, this is a **non-issue** — Reach doesn't spawn CLI processes from Telegram yet. The cwd in the registry is **descriptive** (recording where the session was started), not **prescriptive** (controlling where to spawn).

### Cross-Platform Notes

- Windows uses backslashes; Unix uses forward slashes
- `path.resolve()` handles normalization per-platform
- `config.json` stores paths as-is (platform-native format)
- Phase 11+ (cross-platform daemon) would need path abstraction

For Phase 9 (Windows-only per Phase 8.5 decision), no cross-platform work needed.

### Security Notes

- **Path traversal:** Reject paths containing `..` after normalization (compare input vs. resolved)
- **Symlink following:** `fs.realpathSync()` can be used if paranoid, but not strictly necessary for Phase 9
- **Allowlist vs. denylist:** Paths must be explicitly added (no auto-scan that might expose sensitive dirs)
- **No remote paths:** Reject UNC paths (`\\server\share`) — CLI doesn't support them anyway

### Implementation

**New files:**
- None — extend existing `config.ts` and `handlers.ts`

**Modified files:**
- `config.ts` — add `KnownCwd` type, extend `ReachConfig`
- `handlers.ts` — extend `/new` to parse `--cwd`, add `/cwd` command
- `registry.ts` — no changes (already accepts cwd param)

**Commands:**
```
/new <name> [--cwd <path-or-alias>]   — create session with optional cwd
/cwd list                              — show known cwds
/cwd add [<path>]                      — add path (defaults to current session's cwd)
/cwd remove <alias-or-path>            — remove from list
```

### Scope

- [ ] Extend `ReachConfig` with `knownCwds` array
- [ ] Add config helpers: `addKnownCwd()`, `removeKnownCwd()`, `listKnownCwds()`, `resolveKnownCwd()`
- [ ] Implement `/cwd` command group in handlers.ts
- [ ] Extend `/new` to parse `--cwd` flag
- [ ] Path validation: absolute, exists, no traversal
- [ ] Tests: add/remove/list, validation rejects bad paths, `/new --cwd` works

**Complexity:** M-L (8–12 hours implementation + tests)

### Open Questions for Aaron

5. **Q3-1:** Should git-repo validation be required (`.git/` must exist), or allow any directory?
6. **Q3-2:** Do you want auto-capture (prompt to add cwd from `hello` messages), or manual-only for Phase 9?
7. **Q3-3:** Alias format preference — `@alias` prefix (like above), or some other syntax?
8. **Q3-4:** Should `/cwd` commands work in General Topic, or only in session topics?

---

## Phase 9 Sprint Decomposition

### Task List

| Task | Owner | Depends On | Complexity | Description |
|------|-------|------------|------------|-------------|
| **T1** | Kat | — | S | Item 1: Orientation message on topic activation |
| **T2** | Carter | — | M | Item 2: Slash command pass-through (isBotCommand guard) |
| **T3** | Carter | T2 | S | Item 2: Centralize BOT_COMMANDS set, share between afkMode.ts and handlers.ts |
| **T4** | Jun | T1, T2 | M | Tests for T1 + T2 (orientation message sent once, slash pass-through, bot commands still work) |
| **T5** | Kat | — | M | Item 3: Config schema extension (knownCwds) + helpers |
| **T6** | Carter | T5 | M | Item 3: `/cwd` command group (list/add/remove) |
| **T7** | Carter | T5, T6 | S | Item 3: Extend `/new` to parse `--cwd` flag |
| **T8** | Jun | T5, T6, T7 | M | Tests for Item 3 (cwd validation, add/remove, /new --cwd) |
| **T9** | Scribe | T1-T8 | S | README update + decisions.md merge |

### Dependency Graph

```
T1 ─────┐
        ├─→ T4 ─→ Review
T2 → T3 ┘

T5 → T6 → T7 ─→ T8 ─→ Review

T9 (after all others)
```

Items 1+2 and Item 3 are **independent tracks** — can parallelize.

### Estimated Total

- **Item 1:** 2–3h
- **Item 2:** 4–6h (including T3 shared helper)
- **Item 3:** 8–12h
- **Tests + Docs:** 4–6h
- **Total:** ~20–25h team-wide, 1–2 sessions

---

## Open Questions Summary

Before sprint launch, Aaron should answer:

| # | Item | Question |
|---|------|----------|
| Q1-1 | Orientation | Include last turn summary? (Token cost vs. context value) |
| Q1-2 | Orientation | Add `/status` command for manual refresh? |
| Q2-1 | Slash pass-through | Single authoritative `BOT_COMMANDS` set, or allow duplication? |
| Q2-2 | Slash pass-through | Special handling for `/clear` (confirmation prompt), or pure pass-through? |
| Q3-1 | CWD registry | Require git-repo validation (`.git/` exists), or allow any directory? |
| Q3-2 | CWD registry | Auto-capture from `hello` messages, or manual-only? |
| Q3-3 | CWD registry | Alias syntax preference (`@alias`, or other)? |
| Q3-4 | CWD registry | `/cwd` commands in General Topic only, or also session topics? |

**Blocking:** None — all questions are preference/scope decisions. Defaults can be chosen if Aaron doesn't weigh in:
- Q1-1: No (defer summary)
- Q1-2: No (YAGNI for Phase 9)
- Q2-1: Yes (single source of truth)
- Q2-2: No (pure pass-through)
- Q3-1: No (allow any directory)
- Q3-2: No (manual-only for simplicity)
- Q3-3: `@alias` prefix
- Q3-4: General Topic only (cwd management is daemon-wide, not session-specific)

---

## ADRs / Modules Touched

| Item | Existing ADRs | Modules Modified |
|------|---------------|------------------|
| 1 | ADR-11 (AFK mode) | `src/bot/afkMode.ts` |
| 2 | ADR-8 (protocol), ADR-11 §9 (relay.command envelope) | `src/bot/afkMode.ts`, `src/bot/handlers.ts` |
| 3 | None | `src/config/config.ts`, `src/bot/handlers.ts` |

No new ADRs required — all items are feature additions within existing architectural boundaries.

---

**Generated for:** Reach Phase 9 Design  
**Date:** 2026-05-30T11:32:20-07:00  
**Status:** ✅ Ready for Aaron Review
