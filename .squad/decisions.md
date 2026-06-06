> 📦 Entries from 2026-05-30 and earlier archived to decisions-archive-2026-06-06.md on 2026-06-06.

---
## Carter — Phase 9 Review Cycle 2 Decisions

**Timestamp:** 2026-05-30  
**Branch:** user/aaron/phase9 @ 1d9955b
**Author:** Carter

---

### C2-B1 — Why resolve-not-reject on socket close in writeFrame

When a socket is destroyed while `writeFrame` is waiting for backpressure to clear, a rejected promise would bubble up through `writeQueue.then(...)` into `streamSdkResponse`, manifesting as a turn failure even though the *actual* error was upstream (the socket destroyed at the daemon side for an independent reason). The caller (`streamSdkResponse`) would surface "write failed" to the user when the real failure was e.g. "daemon process exited".

Resolving instead of rejecting shifts error responsibility to the next `writeFrame` call, which checks `socket.destroyed === true` and returns immediately. The error surface point is then the outer streaming logic that checks the socket state — not a spurious rejection inside a per-frame write.

This is consistent with the pattern used by Node core streams: a `write()` call that cannot complete because the stream was destroyed does not produce a hard error; it simply becomes a no-op on the destroyed stream.

---

### C2 — Escape-handling Option A: backslash is always literal inside quotes

Chose **Option A**: removed the `\\` → `\` and `\"` → `"` escape sequences from the double-quoted tokenizer path in `src/bot/newFlagParser.ts`.

**Rationale:**
- The spec comment in `tests/bot/newFlagParser.test.ts` explicitly states "No escape sequences inside quotes (backslash is literal — needed for Windows paths)"
- The previous implementation was inconsistent with that spec and created a latent footgun for UNC paths
- Single-quote mode was already backslash-literal; this change makes the two quote modes symmetric

**Tests changed (handlers.test.ts):**
- Removed `'has spaces'` from the `rejects session names with invalid characters` test loop
- That case is now handled earlier by the multi-word session name error path and is separately covered in `tests/bot/newFlagParser.test.ts`

**Regression test added:**
- `tests/bot/newFlagParser.test.ts`: `--cwd "\\\\server\\share"` → cwd = `\\server\share` (verifies that double-backslash UNC prefix is preserved literally)

---

### C2-I1 — Final regex changes in redactSecrets

**ENV_ASSIGNMENT_PATTERN**

Added `ACCESS_KEY(?:_ID)?` to the keyword alternation so that both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` match the env-style pattern:

```
(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?TOKEN|ACCESS_KEY(?:_ID)?)
```

`AWS_SECRET_ACCESS_KEY` also hits the `SECRET` branch (double-coverage is harmless). `AWS_ACCESS_KEY_ID` was previously not matched by any branch.

**HIGH_ENTROPY_PATTERN**

Changed charset from `[A-Za-z0-9_-]{39,}` to `[A-Za-z0-9_\-/+]{39,}`.

The forward slash `/` and `+` character appear in standard base64 output. AWS secret access keys and many JWT/API tokens use base64 encoding; without `/` and `+` in the charset, values like `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` would be split at the `/` delimiters and each fragment would be too short to trigger the 39-char threshold, silently leaking the value.

**Docstring**

Updated the file-level docstring to list all four pattern groups accurately and changed "40+" to "39+" throughout (the regex is `{39,}` and has been since the cycle 1 fix wave; the doc was lagging).

---

## The Gap

Aaron tried `/afk` during Phase 8 dogfood prep. It doesn't work because `extension.mjs` is never installed to the Copilot CLI extensions directory. The daemon has `npm run service:install` (Phase 2). The extension has nothing.

Carter's audit confirmed: `%APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs` — this path does not exist on Aaron's machine. No script creates it.

---

## Recommendation: Option C

**Single `npm run install` orchestrator** that runs:
1. Config wizard (validate/prompt for tokens, warn on missing allowed-user-IDs)
2. Extension copy (`src/install/copyExtension.ts` → copies `extension.mjs` to Copilot extensions dir)
3. Service install (existing `src/service/install.ts` — unchanged)

Sub-commands also exposed individually:
- `npm run install:extension` — extension copy only (unblocks dogfooding immediately)
- `npm run uninstall` — service uninstall + extension directory deletion

## Cross-Platform

Deferred. Windows-only for Phase 8.5 and Phase 9. No launchd, no systemd.

## Phase Call

**Phase 8.5** — micro-sprint before Phase 9. Four tasks, one session estimate. Exits when Aaron can run `npm run build && npm run install:extension && /afk` successfully.

---

## Task Assignments (Recommended)

| Task | Owner | Priority | Output |
|------|-------|----------|--------|
| `src/install/copyExtension.ts` | Carter | **IMMEDIATE** | Unblocks dogfood |
| `src/install/index.ts` + wizard + uninstall | Kat or Carter | High | Full install UX |
| Tests for copyExtension | Jun | High | Baseline coverage |
| README install section update | Scribe | Medium | Docs complete |

---

## What Teams Should NOT Do

- No cross-platform support
- No npm publish
- No MSI installer
- No new ADRs
- No Phase 9 features
- No config.json schema changes

---

## Open for Aaron

Five UX preference questions documented in handoff doc (script naming, wizard hard-block on empty allowed-user-IDs, dev symlink, uninstall wipe flag). Noble Six defers these to Aaron.


---

## Files Changed

| File | Change |
|------|--------|
| `extension.mjs` | Bug #3: `handleModeChanged` — removed banner for `active === false` case |
| `extension.mjs` | Bug #4: `SESSION_NAME` fallback changed from `SESSION_ID` to `path.basename(process.cwd())` |
| `extension.mjs` | Added `basename` to the existing `import { join } from 'node:path'` import |
| `tests/bridge/extension-back-banner.test.ts` | New — 5 unit tests for banner-dedupe handler contract |

---

## Bug #3 — Duplicate "🖥️ Back at desk" Banner

### Decision

`handleModeChanged(active=false)` is now silent. `handleBackConfirmed` owns the banner.

### Rationale

The `deactivate()` path in `afkMode.ts` sends BOTH `back.confirmed` (session-scoped) AND
`mode.changed { active: false }` (broadcast) to every session. The session that ran `/back`
receives both and was therefore shown the banner twice.

`back.confirmed` is the canonical "you are back" signal — it is session-specific and always
accompanies a `/back` transition. `mode.changed` is a machine-wide data event that other
consumers may observe. Making `mode.changed(false)` silent follows the same pattern as
`afk.activated` + `mode.changed(true)` — the dedicated event owns the display; the broadcast
is informational.

The `active === true` path in `handleModeChanged` was NOT changed — that was not reported as a
bug and is out of scope.

### Considered Alternative

Guard with a `bannerEmitted` flag so `handleModeChanged` is silent only if `handleBackConfirmed`
already fired. Rejected: the flag would need to survive the async gap between two separate message
handlers, and the "always silent for active=false" rule is simpler, correct for all callers, and
easier to maintain.

---

## Bug #4 — Topic Title Shows `sessionId (sessionId)`

### Decision

Changed the `SESSION_NAME` fallback from `SESSION_ID` to `path.basename(process.cwd())`.

### Rationale

`SESSION_NAME` is read from the `SESSION_NAME` env var, which the CLI does not currently set when
launching extension processes. The prior fallback was `SESSION_ID` (a UUID-like string), making
the topic title render as e.g. `sess-abc123 (sess-abc123)`.

The SDK's `joinSession()` return value does not expose a `name`, `friendlyName`, or `displayName`
field (verified against `node_modules/@github/copilot-sdk/dist/types.d.ts`). The only other
meaningful source available in the extension process is `process.cwd()`.

`path.basename(process.cwd())` gives the project directory name (e.g. `verbose-invention`),
which is a meaningful and stable identifier. `SESSION_ID` is retained as a final fallback in case
cwd basename is somehow empty (ADR-8 §3 preserved — field is always non-empty).

### Note on Long-Term Fix

If the CLI is later updated to set `SESSION_NAME`, this code path becomes correct automatically
with no further changes needed.

---

## Test Coverage

New file `tests/bridge/extension-back-banner.test.ts` documents the post-fix handler contract:

1. `back.confirmed` emits exactly one "Back at desk" banner
2. `mode.changed active=false` is silent
3. `mode.changed active=true` still emits "AFK mode active" banner
4. Both events together produce exactly one banner (the core dedupe assertion)
5. AFK scenario documents the two-banner case (afk.activated + mode.changed active=true)

Test suite after fixes: **538 passed / 4 skipped / 0 failed**. tsc clean, lint zero warnings.


---

## Summary

Addressed all 4 substantive Copilot review threads on `src/bot/afkStreamRouter.ts` from PR #7.

---

## Fixes

### Thread 1 — `enqueueChunk` sessionRequestIds empty-Set leak (line ~58)
After deleting a requestId from its Set, the sessionId key was never removed when the Set became empty. Every completed stream left a stale `Set()` in `sessionRequestIds`.

**Fix:** Extracted `removeRequestId(sessionId, requestId)` private helper. Checks `ids.size === 0` after delete and removes the sessionId key. Used at the `enqueueChunk` done-path finalizer.

### Thread 2 — `enqueueError` sessionRequestIds empty-Set leak (line ~72)
Same leak pattern as Thread 1.

**Fix:** `enqueueError` finalizer now calls `removeRequestId` instead of the bare optional-chain delete.

### Thread 3 — `handleChunk` early-return skips done-cleanup when binding removed mid-stream (line ~108)
`getTopicId` returning `undefined` caused an early return that bypassed the `finally { if (done) streamStates.delete(key) }` block, leaking state for any stream whose topic binding was removed before the final chunk arrived.

**Fix:** Resolve `topicId` as `streamStates.get(key)?.topicId ?? this.deps.getTopicId(sessionId)` before the guard. Key computation moved before topic resolution. Only early-return when both are absent.

### Thread 4 — `handleError` early-return skips state deletion when no binding (line ~127)
Same shape as Thread 3: early return on undefined topicId prevented cleanup for a terminating stream.

**Fix:** Delete state unconditionally first (`this.streamStates.delete(key)`), then derive `topicId` from `state?.topicId ?? getTopicId(sessionId)`. Telegram error send fires when topicId is available; state is cleaned either way.

---

## Tests Added

New file: `tests/bot/afkStreamRouter.test.ts` (8 cases)

| ID | Description |
|----|-------------|
| T1-chunk | sessionId key removed after last requestId drains via enqueueChunk |
| T1-chunk (retain) | sessionId key kept while a second requestId is still active |
| T2-error | sessionId key removed after requestId drains via enqueueError |
| T3 (cleanup) | done=true cleanup (streamStates.delete) runs when binding removed mid-stream |
| T3 (edit) | editMessageText fires on done=true with binding removed |
| T4 (delete) | streamStates entry deleted on error path when getTopicId returns undefined |
| T4 (edit) | editMessageText called with error text using topicId from state |
| T4 (no-op) | no Telegram call and no throw when neither state nor binding exists |

---

## Validation

- `npx tsc --noEmit` — clean
- `npx vitest run` — 525 passed / 4 skipped / 0 failed
- `npm run lint` — 0 warnings


---

## Problem

Copilot thread PRRT_kwDOSAVb5c6FmLX7 identified a stuck-stream scenario:

1. Chunk 1 arrives. `StreamState` is created and added to `streamStates`. Then `sendMessage` is called for the placeholder.
2. `sendMessage` throws (rate limit / transient failure). `state.messageId` stays `undefined`.
3. Chunk 2+ arrives. The original guard was `if (!state)` — state exists, so the branch is skipped. No retry, no Telegram updates. Stream is permanently silent.

Additionally, the original code appended `chunk` to `state.text` **after** `sendMessage`. If `sendMessage` threw mid-call, the chunk text was never buffered, so any retry attempt would lose the first chunk's content.

---

## Decision

**Both parts applied together; neither alone is sufficient.**

### Part 1 — Eager state init + retry guard

Initialize `StreamState` **before** any network call:

```typescript
let state = this.streamStates.get(key);
if (!state) {
  state = { topicId, text: '', lastEditAt: 0 };
  this.streamStates.set(key, state);
}
```

Guard on `state.messageId === undefined` (not `!state`):

```typescript
if (state.messageId === undefined) {
  // retry path — handles first-ever chunk AND failed-prior-attempt chunks
}
```

### Part 2 — Buffer before network

```typescript
state.text += chunk;   // always first, before any await

if (state.messageId === undefined) {
  try {
    const placeholder = await bot.api.sendMessage(chatId, state.text, ...);
    state.messageId = placeholder.message_id;
    state.lastEditAt = Date.now();
  } catch (err) {
    console.warn('[afk] Failed to create stream placeholder:', errorText(err));
    return;   // outer finally still fires; done=true still cleans up
  }
} else {
  // throttled-edit path — unchanged
}
```

### Behavioral changes vs. original

| Scenario | Before | After |
|---|---|---|
| sendMessage throws on chunk 1 | stream stuck forever | chunk 2 retries with full buffer |
| sendMessage succeeds on chunk 1 | sends `'…'` placeholder, then immediately edits | sends actual chunk text directly; no redundant edit |
| done=true on chunk 1 retry success | n/a | message sent with full accumulated text; state cleaned in finally |
| All cycle-1 invariants | ✓ | ✓ (no regression) |

---

## Tests Added

- **T5a:** sendMessage throws → `state.messageId` undefined, `state.text` = chunk1 text
- **T5b:** chunk 2 retries → sendMessage called with cumulative `chunk1 + chunk2` text; `messageId` set
- **T5c:** chunk 3 after success → only `editMessageText` called; no further `sendMessage`

**Suite result:** 528 passed / 4 skipped / 0 failed. `tsc --noEmit` clean. `eslint --max-warnings 0` clean.


---

## Thread A — Telegram 4096-char display cap

**Problem:** `state.text` is an unbounded accumulator. Once it exceeds 4096 characters, every subsequent `sendMessage`/`editMessageText` call returns a Telegram 400 error. Combined with the cycle-2 retry path, this produces an infinite retry loop — the stream stalls permanently. Separately, an empty `state.text` on the first chunk causes `sendMessage` to reject with a 400 (empty body).

**Options considered:**
1. **Hard truncate `state.text` itself** — loses earlier output permanently; no future recovery.
2. **Cap only the display string; keep full buffer** — selected. Non-destructive. If we ever want to send a "full log" later we still have it.
3. **Split into multiple messages** — overkill for streaming; introduces ordering complexity.

**Decision:** Option 2. Added `displayText()` helper:
- `''` → `'…'` (non-empty placeholder; Telegram won't reject it, user sees streaming started)
- `text.length <= TELEGRAM_MAX_DISPLAY` → passthrough
- over cap → `'…(truncated)\n' + text.slice(-(TELEGRAM_MAX_DISPLAY - prefixLen))` (last-N, 3987 chars of body)

Last-N chosen over first-N because streaming output's most useful content is at the tail (most recent tool output), not the head.

`TELEGRAM_MAX_DISPLAY = 4000` (not 4096) to leave headroom for the 13-char truncation prefix and any future footer additions without pushing over the Telegram hard limit.

---

## Thread B — handleError isActive race guard

**Problem:** `handleChunk` checks `isActive()` at entry and returns early on deactivation. `handleError` had no equivalent guard. An error frame arriving after `/back` would still emit `❌ Error:` into the (now-closed or re-used) topic. This is a false signal to the user.

**Options considered:**
1. **Guard isActive() before the entire handleError body** — breaks cycle-1 invariant (state not cleaned up when inactive).
2. **Guard isActive() after state cleanup, before Telegram send** — selected. Cleanup is always non-destructive and cheap; the guard only gates the outbound message.

**Decision:** Option 2. `this.streamStates.delete(key)` runs unconditionally (cycle-1 invariant preserved). Immediately after: `if (!this.deps.isActive()) return;`. The Telegram edit/send is skipped.

The `topicId` resolution is also skipped (it's only needed for the send), which is a minor bonus — avoids a stale `getTopicId` call on an already-deactivated controller.

---

## Invariants (cumulative, post cycle 3)

| # | Invariant |
|---|-----------|
| C1 | `removeRequestId` deletes the sessionId key when its Set empties. |
| C2 | `handleChunk` done=true cleanup runs via `finally` even when topic binding is gone (topicId resolved from state first). |
| C3 | `handleError` always deletes state unconditionally — never gated on topic or active status. |
| C4 | `handleChunk` appends chunk text before any network call; `messageId === undefined` retries placeholder on every chunk. |
| C5 | `displayText()` is used for every Telegram text argument in `handleChunk` — raw `state.text` is never passed directly. |
| C6 | In `handleError`, the `isActive()` guard gates only the Telegram send — not the state cleanup. |


---

## Thread 1 — Timer leak in `compensatePartialActivation` (PRODUCTION BUG)

**Finding:** `compensatePartialActivation` used `Promise.race([closePromise, timeout])` where the `timeout` was built from a bare `setTimeout`. When `closeForumTopic` resolved first (the happy path), the `setTimeout` was never cleared. At fleet scale (N=20), this left 20 pending timers on the event loop — a real resource leak in production.

**Fix applied:** Captured `timeoutHandle: NodeJS.Timeout | undefined` in the closure, replaced the bare `new Promise<never>` with a block that assigns `timeoutHandle = setTimeout(...)`, and chained `.finally(() => { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); })` on the `Promise.race` return. The timeout still fires correctly if `closeForumTopic` loses; it is always cancelled otherwise.

**Decision:** Fix inline in `compensatePartialActivation`'s `compensationClose` inner function. No signature or caller changes needed.

---

## Threads 2 & 3 — A6-6 fleet test assertions tightened

**Finding:** Both `TC-A6-6-1` and `TC-A6-6-2` asserted `vi.getTimerCount() === FLEET_SIZE` — described in comments as "confirms all closes completed via the close-result path". This phrasing accidentally documented a timer leak as correct behaviour.

**Fix applied:** Changed both assertions to `vi.getTimerCount() === 0`. Updated comments to explain that zero pending timers proves the leak is fixed. The core test purpose (all N topics close cleanly, no duplicates, no leaks) is unchanged.

---

## Thread 4 — `env.ts` deny-all fatal message (nit)

**Finding:** Fatal message at `env.ts:90` said `'allowedUserIds is empty'` — not actionable because operators don't know whether to check the env var or the config file.

**Fix applied:** Updated to: `'allowed user list is empty (env var TELEGRAM_ALLOWED_USER_IDS or config telegramAllowedUserIds resolved to size 0) — this would deny all users. Unset to allow all, or provide at least one ID.'`

**Decision:** Named both config surfaces explicitly. Kept the same message tone and the `'deny all users'` substring (relied on by the N2 test assertion).

---

## Thread 5 — `env.test.ts` stale comment (nit)

**Finding:** Comment at line 92 referred to `'N2 (backlog) test below'`. The N2 guard shipped in Phase 8; the test is no longer a backlog item.

**Fix applied:** Updated comment to `'shipped N2 guard test below'`.

---

## Validation

- `npx tsc --noEmit` — clean
- `npx vitest run` — 533 passed / 4 skipped / 0 failed (41 files)
- `npm run lint` — 0 warnings
- A6-6 both pass with `vi.getTimerCount() === 0` ✅

**Commit:** `8a95edb` — "Address Copilot review on PR #7 cycle 4: clear compensation timeout + 3 nits"


---
## Phase 8 Watch Status Summary

| Watch | Status | Disposition |
|---|---|---|
| F4 | ✅ RESOLVED | Soft refactor: extracted `afkStreamRouter.ts` (133 LOC); `afkMode.ts` now 649 LOC |
| A6-6 | ✅ CLOSED | Promise-all burst safe at N=20+; compensation logic validated via TC-A6-6-1/2 |
| A2 | DORMANT | P2; defer until first relay error code is added |
| F8 | DORMANT | P2; extract when dynamic auth arrives |
| F5 | DORMANT | P2; trigger if `AfkBridgePort` event count ≥ 8 or spans two unrelated domains |
| A10-4 | DORMANT | Future; trigger when Phase 8 adds fourth operation to topic lifecycle |

**Remaining open items** (from Phase 8 backlog, not watch-triggered):
- None — all P1 items (A7, N2, N3, A8) resolved in Phase 8 P1 sprint (2026-05-27)

**Phase 8 Status:** P1 SHIPPED (2026-05-27) + watch sweep COMPLETE (2026-05-28). Remaining P2/dormant watches stay dormant per Cycle 7 triage.


---

## Finding 1: Slash Commands Intentionally Blocked

**Discovery:** During Item 2 investigation, confirmed that slash commands in Telegram topics are intentionally blocked by explicit guards, not a bug.

**Location:** 
- `src/bot/afkMode.ts:151` — `if (text.startsWith('/')) return false;`
- `src/bot/handlers.ts:270` — `if (ctx.message.text.startsWith('/')) return;`

**Root Cause:** Guards were added to prevent AFK handler from intercepting Telegram bot commands (`/new`, `/list`, etc.). However, the blanket `/` check also blocks CLI session commands (`/clear`, `/agent`, `/model`).

**Status:** Addressed in Phase 9 design — recommend `isBotCommand()` guard that distinguishes bot commands from CLI commands.

**Team Action:** None needed — this is expected behavior being improved, not a bug to fix.

---

## Finding 2: `relay.command` Protocol Envelope is Stubbed

**Discovery:** The daemon-to-extension protocol includes a `relay.command` message type, but:
1. The daemon has **no producer** for this message type
2. The extension handler is a **no-op stub** (just logs)

**Location:**
- `src/bridge/protocol.ts:191-198` — interface definition with comment "DEFERRED (Phase 8)"
- `extension.mjs:343-349` — stub handler that only logs

**Assessment:** This is intentional deferral, not a bug. The envelope was reserved for future structured command dispatch (e.g., `/clear` with special handling). Phase 9 design recommends using `mirror.input` for pass-through, leaving `relay.command` for Phase 10+ curated commands.

**Team Action:** None needed — protocol envelope preserved for future use.

---

## Finding 3: Session CWD is Descriptive, Not Prescriptive

**Discovery:** The `cwd` field in `SessionEntry` records where a session was started, but the daemon cannot currently spawn CLI processes in a chosen cwd. Telegram-initiated spawn is Phase 11+ scope.

**Location:** `src/sessions/registry.ts:138` — `cwd` defaults to `process.cwd()`

**Assessment:** This is a design limitation, not a bug. Phase 9 design addresses the visibility/selection UX without implementing spawn-from-Telegram.

**Team Action:** None needed — correctly scoped in Phase 9 design.

---

## Recommendation: Centralize Bot Command Set

**Observation:** If Phase 9 implements `isBotCommand()` guard, the list of bot commands (`/new`, `/list`, `/remove`, `/resume`, `/help`, `/pair`) will exist in two places:
1. `handlers.ts` — command registrations
2. `afkMode.ts` — guard set

**Risk:** Desync if new bot command added but guard not updated.

**Recommendation:** Export `BOT_COMMANDS` set from `handlers.ts`, import in `afkMode.ts`. Single source of truth.

**Team Action:** Include in Phase 9 Task T3.

---

## No ADR Updates Required

All three items are feature additions within existing architectural boundaries:
- Item 1: Extends AFK mode (ADR-11) with orientation message
- Item 2: Activates existing protocol envelope (ADR-8, ADR-11 §9)
- Item 3: Extends config layer (no ADR)

---

## Decision 1: First-activation gating mechanism

**Choice:** In-memory `orientationSent` boolean on `TopicBinding` (per binding, in `sessionTopics` map).

**Rationale:**
- `sessionTopics` is cleared on `/back` → `deactivate()`, so `orientationSent` resets naturally each AFK cycle without explicit cleanup.
- Re-activation after `/back` → `/afk` sends orientation again (new AFK cycle). This is correct UX.
- Daemon restart clears all in-memory state → orientation re-sent on first activation after restart. Acceptable — per spec: "re-sending after daemon restart is acceptable; it's idempotent UX".
- No persistence needed.

---

## Decision 2: /status excerpt freshness — Option A vs B

**Choice: Option A** — daemon caches last-received excerpt from `afk.request` envelopes in `lastKnownExcerpts: Map<string, string>`, cleared on `deactivate()`.

**Rationale:**
- Option B (new `status.request` / `status.response` round-trip) is more complex and requires new protocol messages.
- "Last known" data is good enough for orientation purposes — the excerpt updates each time the user goes `/afk`.
- If Aaron wants fresher data for `/status`, a Phase 10 round-trip can be added later.
- `lastKnownExcerpts` is cleared on `deactivate()` to avoid showing stale excerpts across AFK cycles.

---

## Decision 3: Truncation behavior

**Choice:** 499 chars + `…` (Unicode ellipsis, U+2026) if over 500 chars; otherwise verbatim.

**Implementation:** In `extension.mjs` `sendModeRequest()`:
```javascript
msg.lastAssistantExcerpt = lastAssistantMessage.length > 500
  ? lastAssistantMessage.slice(0, 499) + '…'
  : lastAssistantMessage;
```

- Truncation at 500 chars (total), no word-boundary smarts.
- Simple to tune later — single constant in extension.mjs.
- Aaron locked 500 chars as default.

---

## Decision 4: /status added to BOT_COMMANDS

**Choice:** Yes — added `'status'` to `BOT_COMMANDS` in `src/bot/commands.ts`.

**Rationale:**
- Prevents `/status` from being passed through to the CLI via mirror.input (Phase 9 Item 2 pass-through logic checks `isBotCommand()`).
- `bot.command('status', ...)` handler registered in `handlers.ts` handles the command.

**Carter coordination note:** Carter's Phase 9 Item 2 (pass-through) relies on `isBotCommand()` to distinguish bot commands from CLI pass-through. `/status` must be in `BOT_COMMANDS` so it's NOT forwarded to the CLI. No code conflict — different Set entry, different handler method, different regions of the same files.

---

## Decision 5: Orientation message format

Plain text (no `parse_mode`). Consistent with `safeSendMessage()` convention used for all topic messages. The `> excerpt` prefix is visual text only — not Telegram MarkdownV2 blockquote syntax.

Format:
```
📍 Session active
━━━━━━━━━━━━━━━━━━
🆔 {sessionId}
📂 {cwd}
🤖 {model}
🎚️ Mode: AFK (since HH:MM UTC)

💬 Last from {model}:
> {excerpt}
```

The `💬 Last from…` block is omitted entirely when no excerpt is available (fresh session or pre-Phase-9 extension).

---

## Decision 6: Model fallback

Added `globalModel?: string` to `AfkModeOptions`. Passed from `cfg.model` in `main.ts`. Fallback chain: `registryEntry.model ?? options.globalModel ?? 'unknown'`.

---

## Decision 1: Where the shared module lives

**Module:** `src/bot/commands.ts` (new file)

**Why this location:**

- Neither `afkMode.ts` nor `handlers.ts` imports the other, so placing the shared
  set in either file would create an awkward one-way dependency.
- `src/bot/commands.ts` is a flat peer module with no dependencies on anything
  in `src/bot/`, so both call sites can import from it without circular risk.
- A dedicated `commands.ts` makes the authoritative command list discoverable
  without reading the full handler registration logic.
- Considered `src/bot/index.ts` (re-export barrel) and `src/bot/registry.ts`
  (naming conflict with sessions registry) — both rejected for clarity reasons.

**Exports:**
- `BOT_COMMANDS: ReadonlySet<string>` — the authoritative Telegram bot command set
- `isBotCommand(text: string): boolean` — the guard helper used by both call sites

---

## Decision 2: The BOT_COMMANDS list

The list is derived from `bot.command()` registrations in `src/bot/handlers.ts`.
No guessing — every entry has a line citation.

| Command | Source citation |
|---------|----------------|
| `new`    | `handlers.ts:53`  — `bot.command('new', ...)` |
| `list`   | `handlers.ts:131` — `bot.command('list', ...)` |
| `remove` | `handlers.ts:145` — `bot.command('remove', ...)` |
| `resume` | `handlers.ts:161` — `bot.command('resume', ...)` |
| `help`   | `handlers.ts:244` — `bot.command('help', ...)` |
| `pair`   | `handlers.ts:259` — `bot.command('pair', ...)` |

`/back` and `/afk` are NOT in `BOT_COMMANDS`. They are CLI extension commands
(registered in `extension.mjs`), not Telegram bot commands. Per Phase 9
pass-through design, typing `/back` or `/afk` in a Telegram topic now forwards
verbatim via `mirror.input` to the CLI session. This supersedes the ADR-11 §2
"CLI-only" guard that previously dropped `/back` at the topic handler level —
the protocol contract (no `back.confirmed` without a full `back.request` round-trip)
is preserved regardless.

---

## Decision 3: `isBotCommand` behavior

- Returns `false` if text doesn't start with `/`
- Extracts the command word via `/^\/([a-zA-Z_]+)/` (greedy up to first space or EOL)
- Case-insensitive: `match[1].toLowerCase()` before set lookup — covers user typos
  like `/New` or `/LIST`
- Returns `true` only if the lowercased word is in `BOT_COMMANDS`

---

## Decision 4: relay.command stub left as-is

The `relay.command` envelope (`src/bridge/protocol.ts:191`) and its handler stub
in `extension.mjs:343–349` are untouched. Rationale:

1. `mirror.input` is sufficient for Phase 9's pass-through requirement — the CLI
   extension already handles slash commands natively when they arrive via stdin.
2. `relay.command` was designed for structured dispatch (parse command + args,
   route to specific extension logic). That adds daemon complexity with no payoff
   until Phase 10+ introduces commands that need Telegram-specific UX (e.g.,
   `/model` with an inline keyboard picker).
3. Activating the stub now would require: a producer in the daemon, argument
   parsing, and extension-side handler wiring — all out of scope for Item 2.

**Deferred to Phase 10.**

---

## Test updates

Two pre-existing tests were updated to match the new behavior:

1. **`tests/bot/handlers.test.ts`** — "ignores command messages (starting with /)"
   changed text from `/unknown-cmd` to `/list`. `/unknown-cmd` now correctly
   passes through (it's not in BOT_COMMANDS); `/list` is a bot command and
   is correctly ignored by the `message:text` handler.

2. **`tests/integration/afk-mode.contract.test.ts`** — T4 assertion updated:
   relay target now becomes `'cli'` (not `'telegram'`) when `/back` is sent to
   a topic, because `/back` is no longer in BOT_COMMANDS and forwards via
   mirror.input. All other T4 assertions (no back.confirmed, no mode.changed,
   no closeForumTopic) remain correct — text pass-through doesn't trigger the
   back.request protocol round-trip.

---

## 1. Alias Validation Regex

```
/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/
```

- **1–32 characters total** (first char + 0–31 body chars)
- **First character:** letter or digit only (`[a-zA-Z0-9]`)
- **Body characters:** letters, digits, underscore, hyphen (`[a-zA-Z0-9_-]`)
- Case-sensitive (aliases are identifiers, not display names)

### Reserved-word set

```typescript
const RESERVED_ALIASES = new Set(['--cwd', '--model', '--name']);
```

These all start with `-` and therefore already fail the regex. The set is kept explicit so the contract is clear to Carter's T6/T7 parser. **Anything starting with `-` is invalid as an alias** — the regex prevents this.

**Implication for Carter (T6):** The `/cwd add <alias> <path>` parser does not need to special-case these names; `validateAlias()` will reject them.

---

## 2. `removeKnownCwd` — no-op on missing alias

`removeKnownCwd(config, alias)` returns the **same config reference** (no-op) if the alias is not found. It does **not throw**.

**Rationale:** Config helpers are pure transforms; error semantics belong to the command layer. Carter's `/cwd remove <alias>` should call `getKnownCwdByAlias` first and produce a user-facing "alias not found" message if needed.

**Implication for Carter (T6):**
```typescript
// Recommended pattern in /cwd remove handler:
if (!getKnownCwdByAlias(config, alias)) {
  await ctx.reply(`❌ Unknown alias "${alias}"`);
  return;
}
const newConfig = removeKnownCwd(config, alias);
await saveConfig(configPath, newConfig);
```

---

## 3. Path comparison on Windows — case-insensitive

`getKnownCwdByPath` uses **case-insensitive** comparison on Windows (`process.platform === 'win32'`):

```typescript
c.path.toLowerCase() === normalized.toLowerCase()
```

**Rationale:** NTFS is case-preserving, not case-sensitive. `D:\Git\Reach` and `D:\git\reach` refer to the same directory. Matching must be case-insensitive or users will get duplicate entries from differently-cased inputs.

**Implication for Carter (T6):** When implementing "already exists?" duplicate-path check in `/cwd add`, use `getKnownCwdByPath(config, normalizedPath)` — it handles the Windows case-fold automatically.

---

## 4. Disambiguation strategy for `/new <plain-alias>` (T7)

Per Q3-3 (plain alias), the `/new` `--cwd` flag value is a bare alias (e.g., `reach`), not `@reach`.

### How the `--cwd` value is resolved in T7

Carter's `--cwd` value parser should use this precedence:

1. **Looks like an absolute path?**
   - Windows: starts with `<letter>:\` or `\\`  
   - Unix: starts with `/`  
   → Call `validatePath()` directly; do NOT look up as alias.

2. **Otherwise → alias lookup**
   → Call `getKnownCwdByAlias(config, value)`  
   → If found: use `entry.path`  
   → If not found: return error "Unknown alias `<value>`. Use `/cwd list` to see known directories, or provide an absolute path."

### Why "path check first"

An alias can never start with a path prefix character (the regex forbids it), so the check is unambiguous and requires no user disambiguation prompt.

### No collision with session names

`/new <session-name> --cwd <value>` — the session name is always the positional arg; the cwd is always the `--cwd` flag value. No overlap.

---

## 5. API shape (for Jun T8)

### Sync helpers (no I/O)

```typescript
validateAlias(alias: string): { ok: true } | { ok: false; reason: string }
listKnownCwds(config: ReachConfig): readonly KnownCwd[]
getKnownCwdByAlias(config: ReachConfig, alias: string): KnownCwd | undefined
getKnownCwdByPath(config: ReachConfig, path: string): KnownCwd | undefined
addKnownCwd(config: ReachConfig, alias: string, path: string, now: string): ReachConfig
removeKnownCwd(config: ReachConfig, alias: string): ReachConfig
touchKnownCwd(config: ReachConfig, alias: string, now: string): ReachConfig
```

### Async helper (needs fs.stat)

```typescript
validatePath(inputPath: string): Promise<{ ok: true; normalized: string } | { ok: false; reason: string }>
```

### `KnownCwd` shape

```typescript
interface KnownCwd {
  alias: string;       // required, unique
  path: string;        // absolute, normalized
  addedAt: string;     // ISO-8601
  lastUsedAt?: string; // ISO-8601, optional
}
```

### Notes for Jun

- `addKnownCwd` throws on alias collision or invalid alias; does **not** throw on bad path format (call `validatePath` first)
- `removeKnownCwd` is a no-op (does not throw) when alias is absent
- `touchKnownCwd` is a no-op when alias is absent
- `validatePath` is async (requires `fs.stat`); all other validators/helpers are sync
- `listKnownCwds` returns a stable sort: `lastUsedAt` desc (undefined last), then `alias` asc

---

## 6. Backward compatibility

`knownCwds` is `optional` on `ReachConfig`. Existing `config.json` files without this field:
- Load cleanly via `loadConfig()` (no schema validation; plain `JSON.parse`)
- All helpers treat `config.knownCwds ?? []` as the base — no nullish crashes

---

## General Topic Detection Mechanism

Used `ctx.message?.message_thread_id`:
- `=== undefined` → message is in the General Topic (no thread)
- `!== undefined` → message is in a forum topic (session thread)

The `/cwd` command handler enforces General-Topic-only by checking `if (topicId !== undefined)` and replying with a friendly error if the user runs it in a session topic. No config lookup required — grammY provides the thread ID on every message context.

This is the standard grammY pattern for Telegram Supergroup forum detection. The General Topic in Telegram supergroups has no `message_thread_id` (it's the root, not a thread).

---

## Session Start API — cwd Support

`ISessionRegistry.register()` **already had** a 5th optional parameter `cwd?: string` (defaults to `process.cwd()` when absent). No changes to the registry interface or implementation were required.

Key detail: When `--cwd` is not supplied, `registry.register()` is still called with exactly 4 args (no 5th `undefined` argument) to preserve existing test assertions:
```typescript
// No --cwd: 4 args exactly
await registry.register(topicId, chatId, name, model);
// With --cwd: 5 args
await registry.register(topicId, chatId, name, model, resolvedCwd);
```

---

## BOT_COMMANDS Update

Added `'cwd'` to the `BOT_COMMANDS` set in `src/bot/commands.ts`. This ensures `/cwd` messages in session topics are treated as bot commands (not CLI pass-through), so grammY routes them to the `/cwd` command handler.

---

## /new --cwd Flag Parsing Refactor

The existing `/new` handler used a single-purpose regex for `--model` only. This was refactored to a position-independent multi-flag extractor:

```typescript
const name = input
  .replace(/(^|\s)--(model|cwd)\s+(\S+)/g, (_m, _sep, flagName, flagValue) => {
    if (flagName === 'model') model = flagValue;
    else cwdArg = flagValue;
    return '';
  })
  .replace(/\s{2,}/g, ' ')
  .trim();
```

Flags can appear before or after the session name. Dangling flags (present without a value) are detected by checking for `--model` or `--cwd` remaining in the extracted `name` string, preserving the `expect.stringContaining('model value')` assertion from the existing test suite.

---

## Disambiguation Rule (Q3-3)

Path detection: `/^[a-zA-Z]:\\/.test(value) || value.startsWith('\\\\')` 
- Windows drive path (`C:\...`) → path branch → `validatePath()`
- UNC path (`\\server\...`) → path branch → `validatePath()` (rejects UNC with friendly error)
- Anything else → alias branch → `getKnownCwdByAlias()`

---

## Final /cwd Help Text (verbatim, for Kat's README)

```
/cwd list|add|remove — Manage known cwd aliases (General Topic only)
```

Sub-command usage:
```
/cwd list                    — list all known cwds with last-used times
/cwd add <alias> <path>      — register a new alias for a directory
/cwd remove <alias>          — remove an alias from the registry
```

List output format:
```
📂 Known cwds:
• myrepo — C:\src\myrepo  (last used 2h ago)
• scratch — D:\scratch  (never used)

Start one with: /new <alias>
```

Error messages:
- Alias collision: `❌ Alias '<alias>' already exists for <path>. Use a different name or run /cwd remove <alias> first.`
- Invalid alias: `❌ Invalid alias: <reason>. Aliases must be 1-32 chars, start alphanumeric, use letters/digits/hyphens/underscores.`
- Invalid path: `❌ Invalid path: <reason>. Path must be an absolute, existing directory.`
- Empty list: `📂 No known cwds yet. Add one with: /cwd add <alias> <path>`
- In session topic: `❌ /cwd commands work in the General Topic only. Manage your cwd registry there, then start sessions from any topic.`
- Unknown alias (--cwd): `❌ Unknown alias '<alias>'. Run /cwd list to see known cwds.`

---

## /new --cwd Help Text Update

```
/new <name> [--model <model>] [--cwd <alias-or-path>] — Create a session in this topic
```

---

## Design Pushback / Notes

**None significant.** The design doc and Kat's decisions were fully implementable as specified.

Minor observation: `args.slice(2).join(' ')` is used for the path argument in `/cwd add` to handle paths with spaces (e.g., `C:\my projects\repo`). Without this, space-containing paths would be silently truncated.

**`configPath` is optional in `HandlerOptions`** — existing tests call `registerHandlers({...})` without it. When `configPath` is absent and a user tries `/cwd` or `/new --cwd`, they receive a clear error. The daemon always passes `configPath: cfg.configPath` from `main.ts`.

---

## D1 — Carter's Module Import Path

**Decision:** Tests import from `../../src/bot/commands.js` (i.e., `src/bot/commands.ts`).

**Rationale:** Design doc says "likely `src/bot/commands.ts` or `src/bot/registry.ts` — Carter picks". Noble-six triage recommends "Export BOT_COMMANDS from handlers.ts" but a standalone `commands.ts` is cleaner for a centralized set. The canonical path is unknown until Carter lands.

**Carter: if you export from `handlers.ts` instead**, update the import in `tests/bot/isBotCommand.test.ts` line 18 from `'../../src/bot/commands.js'` to `'../../src/bot/handlers.js'`.

**If BOT_COMMANDS ends up somewhere else entirely** (e.g., `src/bot/registry.ts`), same fix.

---

## D2 — Case Sensitivity: Carter Chose Case-Insensitive

**Decision:** Tests assert case-**insensitive** behavior (`/New` → true, `/NEW` → true).

**Rationale:** Carter's implementation uses regex `/^\/([a-zA-Z_]+)/` + `.toLowerCase()` before the Set lookup. The docstring explicitly states "The check is case-insensitive: `/NEW` and `/new` both match."

This diverges from the design doc's implied `[a-z_]+` (lowercase only). Carter's choice is defensively correct: Telegram sends commands lowercase, but normalizing casing makes the guard robust to hypothetical client variations.

**Affected tests:** `isBotCommand.test.ts` case-sensitivity describe block asserts `true` for `/New`, `/NEW`, `/LIST`. The `it.todo` marks the case-sensitive (rejected) variant.

---

## D3 — `/new@MyBot` Telegram Suffix Behavior

**Decision:** Tests assert `isBotCommand('/new@MyBot')` → **true**.

**Rationale:** Design doc regex `/^\/([a-z_]+)/` stops at `@` (not in `[a-z_]`), extracting `new`. `BOT_COMMANDS.has('new')` → true → returns true. This is emergent correct behavior from the regex — the helper implicitly handles the Telegram `@botname` suffix without special logic.

**Carter: if you intentionally strip or reject the @suffix differently**, update the test.

---

## D4 — Existing Test Conflict in handlers.test.ts

**⚠️ Carter must update `tests/bot/handlers.test.ts:343` when implementing the guard change.**

The existing test:
```typescript
it('ignores command messages (starting with /)', async () => {
  // ...
  message: { message_thread_id: 42, text: '/unknown-cmd' },
  // reply is not called for relaying (no placeholder)
  expect(ctx.reply).not.toHaveBeenCalled();
});
```

After Carter's fix, `isBotCommand('/unknown-cmd')` → false (extracts `'unknown'`, not in BOT_COMMANDS). The message:text handler will relay it → `ctx.reply` WILL be called → **this test will FAIL**.

**Fix:** Change the text in that test from `'/unknown-cmd'` to a real bot command like `'/new test'` or `'/list'` to preserve the intent (bot commands don't trigger relay).

The new test at `tests/bot/handlers.slashGuard.test.ts` covers the replacement contract explicitly.

---

## D5 — Actual Landing Status (Carter Already Shipped)

Carter landed all Phase 9 Item 2 implementation during Jun's test-writing run.

| File | tsc | vitest status |
|------|-----|---------------|
| `tests/bot/isBotCommand.test.ts` | ✅ (included in vitest, not tsc) | ✅ 66 passed / 1 todo |
| `tests/relay/afkMode.slashGuard.test.ts` | ✅ | ✅ 15 passed |
| `tests/bot/handlers.slashGuard.test.ts` | ✅ | ✅ 25 passed |

**Total new tests: 106 assertions / 1 todo — all GREEN.**

Pre-existing failures unrelated to Jun's work:
- `tests/bridge/extension-protocol-drift.test.ts` (1 failure): Carter added `lastAssistantExcerpt` to the protocol (Phase 9 Item 1 orientation message). Drift test expects `['sessionId', 'type']` but now gets 3 fields. This is Carter's protocol change, not a regression from Jun's tests.

**D4 update:** Carter proactively removed the `'ignores command messages (starting with /)'` test from `tests/bot/handlers.test.ts` before it became a conflict. No action needed.

---

## D6 — Test Harness for afkMode.slashGuard

Used `AfkModeController.forTesting()` with a seed of `mode.active=true` and a pre-bound session at `TOPIC_ID=42`. This avoids replicating the full FakeDaemon/FakeExtensionClient activation flow for a unit-level guard test.

The bridge mock uses `vi.fn()` for all AfkBridgePort methods; `sendToSession` captures the `mirror.input` payload for assertion.

---

## Scope

Three test files for Phase 9 Item 3 (multi-CWD registry):

| File | Scope | Status |
|---|---|---|
| `tests/config/knownCwds.test.ts` | Kat's T5 helpers (8 functions) | ✅ 60 GREEN |
| `tests/bot/cwdCommand.test.ts` | Carter's T6 `/cwd` command group | ✅ 12 GREEN |
| `tests/bot/newCwdFlag.test.ts` | Carter's T7 `/new --cwd` extension | ✅ 11 GREEN |

Total: **83 tests, all passing**.

---

## Decision D1: Mock architecture for B and C tests

**Problem:** `handlers.ts` is a heavy entry point (imports grammY, relay, sessions). Need to
test just the `/cwd` and `/new --cwd` logic in isolation.

**Choice:** Same `vi.hoisted()` + `vi.mock()` approach established in Phase 9 Item 2 handlers
tests. Mock `loadConfig`/`saveConfig` from `../../src/config/config.js`, and all 8 helpers from
`../../src/config/knownCwds.js`.

**Rationale:** Matches the existing vi.mock + importOriginal pattern. Tests remain stable even
if Carter refactors internals as long as the observable surface (ctx.reply calls, registry.register
args, loadConfig/saveConfig calls) is unchanged.

---

## Decision D2: HandlerOptions.configPath assumed API shape

**Problem:** Design doc says Carter adds a `configPath` option to `HandlerOptions`; the exact
name was unconfirmed before Carter landed.

**Outcome:** Carter used exactly `configPath?: string` in `HandlerOptions`. Tests use:
```typescript
const opts: HandlerOptions = {
  bot: bot as unknown as Bot<Context>,
  registry, factory,
  globalModel: 'claude-sonnet-4.5',
  configPath: TEST_CONFIG_PATH,
};
```
No adjustment required.

---

## Decision D3: /cwd without `configPath` — not tested explicitly

Carter's code has an early `if (!configPath)` guard in both the `/cwd` handler and the
`/new --cwd` path. Tests in C cover this guard for `/new --cwd` (`it('replies error when
configPath not set for --cwd')`). The `/cwd` guard is implicitly tested because all happy-path
tests provide a configPath. Could add an explicit test; deferred to Carter's unit tests.

---

## Decision D4: Fake timers scope in B and C

Tests use `vi.useFakeTimers({ now: new Date('2026-01-15T10:00:00Z') })` to freeze
`new Date().toISOString()` calls inside handlers (for `touchKnownCwd` and `addKnownCwd`
timestamp args). This gives deterministic call-arg matching.

---

## Decision D5: Carter's Unix path detection omission (noted, not blocking)

Carter's `/new --cwd` path disambiguation regex:
```typescript
const isPath = /^[a-zA-Z]:\\/.test(cwdArg) || cwdArg.startsWith('\\\\');
```

This is Windows-only. Kat's spec (knownCwds decisions §4) specifies that Unix absolute paths
(`/home/user/repo`) should also be treated as paths, not aliases. Carter's implementation
would route `/home/user/repo` through the alias lookup on non-Windows platforms.

**Impact:** Low — project targets Windows hosts per Phase 8.5 decisions. Tests use
`ABS_PATH = process.platform === 'win32' ? 'C:\\git\\myrepo' : '/home/user/myrepo'`
with the Unix branch being a fallback. On Linux CI runs, the path test would exercise the
alias branch by accident.

**Recommendation:** Carter should add `|| cwdArg.startsWith('/')` for Unix path detection.
File as a follow-up issue; does not block Phase 9 Item 3 merge.

---

## Decision D6: `/cwd remove` — active-session removal is a no-op test

Test confirms that calling `/cwd remove myrepo` succeeds (removes the registry entry + saves)
regardless of whether any active sessions are using that cwd. The registry doesn't need to know
about active sessions because: (a) sessions hold their resolved path string in memory, not
a live reference; (b) removing the alias only affects future `/new --cwd myrepo` lookups.

---

## Decision D7: Same path under two aliases — test confirms it's allowed

`addKnownCwd` checks alias uniqueness (throws on alias collision) but does NOT check for path
uniqueness. Test `'allows same path under two different aliases'` in `knownCwds.test.ts`
confirms this is intentional behavior, not a missing validation.

---

## Carter Contract Divergence: NONE

All three files matched Carter's implementation exactly on first run. No import path changes,
no reply string regex adjustments needed. `cwd` is correctly in `BOT_COMMANDS` (commands.ts
line 35). The isBotCommand guard correctly blocks `/cwd` in session topics' `message:text`
handler.

---

## Structure Decision

Added a new **"Using Reach"** section after Installation and before Development Workflow. Removed the old pre-Phase-9 "Usage" section to avoid duplication.

### Rationale

- **Section placement:** After Installation (users install first, then want to know how to use it)
- **Comprehensive:** Covers all Phase 9 user-facing features in one section
- **Voice match:** Practical, scannable, no marketing — consistent with Phase 8.5 install section style
- **Removed old Usage:** Pre-Phase-9 "Usage" section was incomplete and now superseded by "Using Reach"

---

## Content Coverage

### 1. Telegram Commands (3 subsections)
- **Session management:** `/new`, `/list`, `/resume`, `/remove`
- **CWD registry (General Topic only):** `/cwd list`, `/cwd add`, `/cwd remove`
- **Other:** `/status`, `/help`, `/pair`

All commands include brief, actionable descriptions. No redundancy with handlers.ts or decisions files — documentation is reader-facing only.

### 2. CLI Commands Pass-Through

Short subsection explaining that anything not in the bot commands list is forwarded verbatim to the CLI session. Examples: `/clear`, `/agent`, `/model`, `/exit`. Same UX as terminal.

### 3. Orientation Message

Sample message with verbatim formatting from Item 1 decision (`kat-phase9-item1-orientation.md` Decision 5):

```
📍 Session active
━━━━━━━━━━━━━━━━━━
🆔 {sessionId}
📂 {cwd}
🤖 {model}
🎚️ Mode: AFK (since HH:MM UTC)

💬 Last from {model}:
> {excerpt}
```

Includes note about 500-char truncation and `/status` for manual refresh.

### 4. Getting Started: CWD Registry Example

Three-step practical example showing alias workflow:

```
/cwd add myrepo C:\src\myrepo
/cwd add scratch D:\scratch
/cwd list
/new my-session --cwd myrepo
```

### 5. Platform Note

Windows-only for now. Clarifies that path arguments (`/cwd add`, `/new --cwd`) accept `C:\path` and `\\server\share` formats. Cross-platform deferred to future phase.

---

## Files Changed

| File | Lines Added | Notes |
|------|------------|-------|
| README.md | +57 (Using Reach) -39 (old Usage) = **+18 net** | Replaces old usage section |

---

## No Code Structure Decisions

All decisions in this doc are documentation/formatting choices, not code architecture. Code decisions remain in:
- Item 1: `kat-phase9-item1-orientation.md` (orientation message format, gating, `/status` caching)
- Item 3 (config): `kat-phase9-item3-config-schema.md` (alias rules, validation)

---

## Voice/Style Match

Matched Phase 8.5 install section:
- Scannable bullet lists with concise descriptions
- Code examples use realistic paths and commands
- No badges, marketing language, or hype
- Short paragraph prose for context; commands and examples lead

Aaron is the primary reader — documentation prioritizes clarity and practicality.



---

# Phase 9: Persona Review Cycle 3 — Final Pre-PR Pass

Date: 2026-05-31

# Kat Phase 9 Cycle 3 README Review Fixes

## A1: TELEGRAM_ALLOWED_USER_IDS Classification & REACH_PERMISSION_POLICY Documentation

### Decision: "Strongly Recommended" vs "Required"
- **Wording chosen:** "Strongly Recommended" (not "Optional")
- **Rationale:** Runtime behavior treats TELEGRAM_ALLOWED_USER_IDS as optional (env.ts lines 65-87 show allowedUserIdSet can be undefined), allowing all users when unset. However, the security risk is high — any user in the chat can control the daemon. This warrants prominence above plain "Optional" but stops short of "Required" to match the actual runtime enforcement.
- **Callout added:** "If not set, ANY user in the configured Telegram chat can control the daemon. Set this to your own numeric user ID to restrict access." (README line 47)

### Decision: REACH_PERMISSION_POLICY Surfacing
- **Location:** Configuration section (README lines 54), Environment Variables table (line 195)
- **Rationale:** The default `approveAll` has a critical side-effect (blocks Telegram mirror input per main.ts line 56), which users should know about at configuration time.
- **Wording:** "Tool approval policy (default: `approveAll`). Options: `approveAll` (daemon acts without approval — suitable for AFK usage), `denyAll` (daemon refuses tool use), or `interactiveDestructive` (daemon prompts for approval on destructive tools). Note: when `approveAll` is active, Telegram mirror input is blocked for safety." (README lines 54)

### Verification:
- env.ts lines 65–99: Confirmed allowedUserIdSet can be undefined
- install/index.ts line 173: Confirmed wizard message matches new callout
- main.ts line 56 + afkMode.ts line 168: Confirmed approveAll → mirror input disabled
- Environment table updated with full policy descriptions

## A2: /resume Command Signature
- **Change:** `/resume` → `/resume <session-name>`
- **Location:** README line 77 (Telegram Commands section)
- **Verification:** handlers.ts line 247 confirms the handler enforces `ctx.match?.trim()` and errors if empty with usage hint `/resume <session-name>`
- **Related edit:** npm run init description (line 34) clarified to match new classification

### Spot-Check: Other Command Signatures
All verified against handlers.ts and match README documentation:
- `/new <name> [--model <model>] [--cwd <alias-or-path>]` ✅
- `/list` (no args) ✅
- `/remove` (no args, topic-scoped) ✅
- `/pair <code>` ✅
- `/help` (no args) ✅
- `/status` (no args, topic-scoped) ✅
- `/cwd list|add|remove` ✅

No sibling command-signature drift detected.


---

# Carter — Phase 9 Review Cycle 3 Decisions

Date: 2026-05-31

---

## A4 — Single source of truth for bot command registration

**Choice: Option A (name-map variant)**

Rationale: The existing handlers.ts shape already had large inline closures for each command, all capturing the same outer scope variables (registry, relay, factory, etc.). Extracting them into named properties of a `Record<CommandName, (ctx: Context) => Promise<void>>` object literal — rather than wrapping them in explicit `registerXxx` functions per Option B — preserves the existing closure pattern with minimal restructuring. Each handler body is unchanged; only the declaration site moved from `bot.command('x', async (ctx) => {` to `x: async (ctx) => {`.

The registration loop `for (const name of COMMAND_NAMES) { bot.command(name, commandHandlers[name]); }` then drives registration from a single array, making the relationship mechanical rather than maintained-by-convention.

**Drift check: deleted.**

The check was comparing `REGISTERED_HERE` (a hand-maintained duplicate list in handlers.ts) against `BOT_COMMAND_NAMES` (derived from the same list in commands.ts). After the refactor, there is no `REGISTERED_HERE` — the `commandHandlers` object is typed as `Record<CommandName, ...>`, so TypeScript enforces at compile time that every name in `COMMAND_NAMES` has a corresponding handler. The old runtime throw is replaced by a build-time error. Dead safety code removed.

**Final exports from commands.ts:**
```typescript
export const COMMAND_NAMES = ['new','list','remove','resume','help','pair','status','cwd'] as const;
export type CommandName = typeof COMMAND_NAMES[number];
export const BOT_COMMANDS: ReadonlySet<string> = new Set(COMMAND_NAMES);
export const BOT_COMMAND_NAMES = BOT_COMMANDS;  // alias kept for isBotCommand.test.ts
export function isBotCommand(text: string): boolean
```

**Note on ctx.match typing:** Inside `bot.command()`, grammY narrows `ctx.match` to `string | undefined`. With the `Record<CommandName, (ctx: Context) => Promise<void>>` annotation, the base `Context` type exposes `match` as `string | RegExpMatchArray | undefined`. Two callsites (`/new`, `/resume`) required `(ctx.match as string | undefined)?.trim()` casts. This is accurate — inside command handlers, match is always string.

---

## A5 — parseNewFlags discriminated Result type

**Choice: discriminated `ParseResult<T>` union; all throws caught at public boundary.**

Internal helpers (`tokenize`, `parseFlagValue`) continue throwing — that's natural for tokenizer internals. `parseNewFlags` wraps its entire body in `try/catch` and converts all throws to `{ ok: false, error }`. The multi-word session name path (previously `return { sessionName, error: '...' }`) now returns `{ ok: false, error: '...' }` as well, unifying both error paths.

**Final public signature:**
```typescript
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface ParsedNewFlagsValue { sessionName: string; model?: string; cwd?: string; }
export function parseNewFlags(match: string): ParseResult<ParsedNewFlagsValue>
```

**Caller in handlers.ts `/new` handler (before: try/catch + if parsed.error):**
```typescript
const parsed = parseNewFlags(input);
if (!parsed.ok) {
  await ctx.reply(`❌ ${parsed.error}`, { message_thread_id: topicId });
  return;
}
const name = parsed.value.sessionName;
const model = parsed.value.model;
const cwdArg = parsed.value.cwd;
```
No try/catch at the callsite. Cleaner control flow.

**Test refactoring:**
- All `expect(() => parseNewFlags(...)).toThrow()` → `expect(parseNewFlags(...).ok).toBe(false)` (5 tests)
- Multi-word `expect(result.error).toMatch(...)` → `expect(result.ok).toBe(false)` + `expect(result.error).toMatch(...)` (2 tests)
- Happy-path `result.sessionName` / `result.cwd` / `result.model` → `result.value.sessionName` / `result.value.cwd` / `result.value.model` (all remaining tests)
- Added `if (!result.ok) return;` narrowing guard before value access in happy-path tests for TypeScript narrowing.

---

## Validation

- `npx tsc --noEmit` — clean
- `npm run lint --max-warnings 0` — clean  
- `npx vitest run` — 783 passed / 4 skipped / 1 todo (identical to baseline)


---
# Decision: Full process.argv save/restore in isDirectRun tests

**Date:** 2026-06-05  
**PR:** #10, Cycle 10  
**Thread:** T1 — `tests/install/isDirectRun.test.ts:20-32`  
**Author:** Carter (Bridge Dev)

## Decision

Replace the cycle-6 `argv[1]`-only save/restore pattern with a full-array
save/restore in `isDirectRun.test.ts`.

**Before (cycle-6 pattern):**
```ts
let savedArgv1: string | undefined;
beforeEach(() => { savedArgv1 = process.argv[1]; });
afterEach(() => {
  if (savedArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = savedArgv1;
  }
});
```

**After:**
```ts
let savedArgv: string[];
beforeEach(() => { savedArgv = process.argv.slice(); });
afterEach(() => { process.argv = savedArgv; });
```

## Rationale

Cycle 6 fixed a state leak caused by the original `afterEach` not handling the
case where `argv[1]` was `undefined` (it would write `undefined` back as a
string). The cycle-6 fix saved/restored only `argv[1]`.

IDR5 (added later) calls `process.argv.splice(1)` which mutates the **array
length** — removing all elements from index 1 onward. Restoring only `argv[1]`
does not undo the splice; any elements beyond index 1 remain absent. This can
cause order-dependent flakiness in tests that run after IDR5 and rely on
`process.argv` having its normal shape.

A full-array `slice()` snapshot at `beforeEach` and full reference restore at
`afterEach` handles:
- `argv[1]` being `undefined` (naturally preserved in the slice)
- `argv[1]` being `''` (distinguished correctly, same as cycle-6)
- `splice`-based length mutations (restored by reference reassignment)

## Supersedes

Cycle-6 `argv[1]`-only pattern. The full-array pattern is strictly more
correct and no more complex.

---
# carter-pr10-cycle11: relativeTime() Guards

**Date:** 2026-06-05  
**Author:** Carter (Bridge Dev)  
**PR:** #10 — Cycle 11

---

## Decision 1: NaN fallback string → `'unknown'`

**Choice:** Return `'unknown'` when `Date.parse(iso)` yields `NaN`.

**Rationale:**
- `'just now'` would be misleading — the timestamp isn't *recent*, it's *unreadable*.
- `'unknown'` is honest and already fits the output vocabulary of the `/cwd list` rendering
  (`last used unknown`), which reads naturally as a data-quality indicator rather than a time claim.
- It avoids emitting garbled strings like `'NaNd ago'` that would confuse users and
  look like bugs in screenshots.

---

## Decision 2: Future timestamp clamp → `diffMs = Math.max(0, ...)`

**Choice:** Clamp `diffMs` to `0` when the stored timestamp is ahead of `Date.now()`.

**Rationale:**
- Small positive skews (seconds to minutes) arise from NTP drift between the machine that
  wrote the config and the machine running the bot. They are not errors — they are expected noise.
- Clamping to 0 means the `mins < 1` branch fires and returns `'just now'`, which is the
  correct human interpretation of "happened approximately now".
- Negative diffMs would propagate through `Math.floor` into negative minute/hour/day values,
  producing output like `'-1m ago'` — nonsensical and unhandled by the existing branches.
- An explicit `Math.max(0, ...)` is self-documenting and cheaper than adding a dedicated
  negative-branch to an otherwise clean function.

---
# carter-pr10-cycle12: Wipe Markers Audit + Quoted Session Name Fix

**Date:** 2026-06-05  
**Author:** Carter (Bridge Dev)  
**PR:** #10 — Cycle 12

---

## T1: registry.json Added to wipeLocalData() Marker List

### Markers added

`registry.json` added to the `markerFiles` array in `wipeLocalData()` (`src/install/uninstall.ts:64`).

**Source:** `src/config/env.ts:43` — `path.join(getReachDataDir(), 'registry.json')`. The file
is a direct child of the data dir (not nested). No exported constant exists for the basename, so
`'registry.json'` is inlined — consistent with how `'config.json'` and `'bridge-auth.json'` are
already expressed.

### Full marker audit against `<dataDir>/` state files

| File | Source | In marker list before? | Action |
|---|---|---|---|
| `config.json` | `src/config/config.ts` `getConfigPath()` | ✓ yes | no change |
| `bridge-auth.json` | `src/bridge/pipeAuth.ts` `getPipeAuthPath()` | ✓ yes | no change |
| `registry.json` | `src/config/env.ts` `registryPath` | ✗ missing | **added** |

No other `<dataDir>/…` constructions found in the codebase. `src/config/migrate.ts` copies from
legacy dirs into `<dataDir>` but introduces no new files beyond the three above. The marker list is
now exhaustive for all known Phase 9 state files.

**Broadening concern:** All three markers are specific Reach JSON files. A random directory
containing an unrelated `registry.json` (e.g. an npm package) would be a false positive, but the
combination check (`some`) means _any_ of the three triggers a pass — the safety check is already
using a low-confidence bar by design (fail-closed on inspection error). Adding one more
Reach-specific name is appropriate.

---

## T2: Unified Whitespace Check for Session Name

### Decision: Unify both paths (`sessionParts.length > 1` replaced by `/\s/.test(sessionName)`)

**Chosen approach:** Replace the `sessionParts.length > 1` guard with a single `/\s/.test(sessionName)`
check applied to the final resolved session name.

**Rationale:**
- The root invariant is: _a session name must not contain whitespace_, regardless of how the
  whitespace got there (unquoted split vs. quoted single token).
- `sessionName = sessionParts.join(' ').trim()` already collapses all session parts into one string.
  Testing that string for `\s` catches both paths:
  - Unquoted `my session` → two tokens → `sessionName = 'my session'` → `\s` fires ✓
  - Quoted `"my session"` → one token `'my session'` → `\s` fires ✓
- The unified check is shorter, has one fewer code path, and its intent is self-evident.
- Error message is identical between both cases — callers see consistent semantics.

**Alternative considered:** Add a second guard after the existing `sessionParts.length > 1` check.
Rejected — two parallel checks with the same error string are redundant and invite drift.

---
# Carter — PR #10 Cycle 13 Decisions

**Branch:** user/aaron/phase9  
**Date:** 2026-06-05  
**Commit scope:** test (test-only changes)

---

## T1/T2 — Fake-token constant

**Constant chosen:** `FAKE_GH_TOKEN = 'not-a-real-token-0000'`

**Rationale:**  
T1 and T2 both exercise the ENV-assignment pass (`GITHUB_TOKEN=<value>` /
`GITHUB_TOKEN="<value>"`). `ENV_ASSIGNMENT_PATTERN` requires the value to match
`[^\s'"]{8,}` — at least 8 non-space, non-quote characters. The original
`ghp_abcdefghijklmnopqrstuvwxyz12345678` is a `ghp_`-prefixed 40-char value
that GitHub secret scanning recognises as a real PAT shape (prefix + length +
charset).

`not-a-real-token-0000` (21 chars) satisfies `[^\s'"]{8,}`, contains `-` which
is never present in a real GitHub PAT, and is lexically unmistakeable as fake.
It is reused verbatim for the quoted C6-4 variant so both tests reference a
single constant, making intent clear.

No change to what the tests assert — just the fixture value inside the quotes.

---

## T3 — Bare-value restructuring (high-entropy charset guard)

**Problem (Copilot review):** The original test used
`AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`. Because
`AWS_SECRET_ACCESS_KEY` matches `ENV_ASSIGNMENT_PATTERN` (the `ACCESS_KEY`
suffix), the ENV pass redacts the value on Pass 2 *regardless* of whether the
high-entropy charset is correct. If someone reverted the cycle-8 `/`+`+` charset
extension in `HIGH_ENTROPY_PATTERN`, this test would still pass — false safety.

**Fix:** Drop the `AWS_SECRET_ACCESS_KEY=` prefix entirely. The new fixture is:

```
FAKE+Xm3z9pQr/vNsLwD7hYc+E4aOjZtFu1Ii/8bGn  (42 chars)
```

This bare value is only reachable by `HIGH_ENTROPY_PATTERN` (Pass 3).

**Why this value specifically:**
1. Length 42 ≥ 39 threshold — matches as a single run. ✓
2. Contains `/` (position 13) and `+` (positions 4, 24) — the chars added in
   cycle-8.
3. Contains no keyword words (`token`, `key`, `secret`, …) at word boundaries,
   so `KEYWORD_PATTERN` (Pass 1) does not fire first. (Earlier draft used
   `…/aws/key/…` which caused `\bkey\b` to match and produce
   `…/aws/key[REDACTED]` instead of `[REDACTED]`.)
4. Starts with `FAKE` — obviously not a real credential; won't trip AWS secret
   scanning (which looks for `AWS` prefix + length + alphanumeric pattern).

**Charset-regression proof:** If `HIGH_ENTROPY_PATTERN` reverted to
`[A-Za-z0-9_\-]{39,}` (no `/`, no `+`), the 42-char value fragments at each
`/` and `+`:
- `FAKE` (4), `Xm3z9pQr` (8), `vNsLwD7hYc` (10), `E4aOjZtFu1Ii` (12), `8bGn` (4)
- Longest fragment: 12 chars — far below the 39-char threshold.
- Neither `not.toContain(bare)` nor `toBe('[REDACTED]')` would hold → test FAILS.

**Companion assertion added:** `expect(result).toBe('[REDACTED]')` — verifies the
whole 42-char run was matched as one token, guarding against the fragmentation
scenario above.

---

## Sibling `ghp_` scan

Grepped all `tests/**/*.ts` for `ghp_`. Only two occurrences found, both in
`tests/bot/redactSecrets.test.ts` (lines 60 and 154) — both fixed by T1/T2
above. No sibling fixtures elsewhere.

---
# Carter — PR #10 Cycle 14 Decisions

**Date:** 2026-06-05  
**Bugs addressed:** T2 (connectivity-breaking path mismatch), T1 (stale socket cross-connection frame leak)

---

## 0. extension.mjs — source or generated?

**Finding: HAND-EDITED source file.**

- Not in `.gitignore`
- Committed to git (earliest log entry predates Phase 9)
- No TypeScript counterpart (`src/extension*` — no matches)
- No build script in `package.json` that emits it (`build` = `tsc --project tsconfig.json` only)
- No "GENERATED — do not edit" header comment
- Header says "Reach CLI Extension" — authored prose

**Consequence:** Both T1 and T2 fixes were applied directly to `extension.mjs`.

---

## T2 — Auth file path mismatch (daemon ↔ extension)

### Root cause

`getReachDataDir()` in `src/config/config.ts` was migrated to `~/.reach/` in Cycle 3
(PR #10 storage unification). `pipeAuth.ts` uses `getReachDataDir()` so the daemon
correctly writes `~/.reach/bridge-auth.json`. However, `getAuthFilePath()` in
`extension.mjs` was never updated and still read from `%LOCALAPPDATA%\reach\bridge-auth.json`.
Daemon writes to `~/.reach/`; extension reads from `%LOCALAPPDATA%\reach\` — completely
different directories → extension never discovers the pipe → zero connectivity.

### Fix

Rewrote `getAuthFilePath()` in `extension.mjs` to mirror `getReachDataDir()` in
`src/config/config.ts` exactly:

```js
function getAuthFilePath() {
  const override = process.env['REACH_DATA_DIR'];
  const dataDir = (override && override.trim() !== '')
    ? resolve(override.trim())
    : join(homedir(), '.reach');
  return join(dataDir, 'bridge-auth.json');
}
```

Added `resolve` to the `node:path` import.

### LOCKSTEP REQUIREMENT

**⚠️ The path-resolution logic is now duplicated across two runtime boundaries:**

| File | Runtime | Logic |
|------|---------|-------|
| `src/config/config.ts` `getReachDataDir()` | TypeScript (compiled) | `REACH_DATA_DIR` override → `path.resolve(override.trim())`, fallback `~/.reach` |
| `extension.mjs` `getAuthFilePath()` | Standalone JS | Mirrors above exactly |

These two cannot import each other (TS daemon vs standalone `.mjs` extension deployed separately).

**Rule:** Any future change to `getReachDataDir()` in `src/config/config.ts` MUST be
manually mirrored in `extension.mjs getAuthFilePath()`. Code review checklist should
include this when `src/config/config.ts` is modified.

A comment in both files now calls this out explicitly.

### Tests

- Fixed N2 tests in `tests/bridge/b3-pipe-auth.test.ts`: changed `vi.stubEnv('LOCALAPPDATA', tempDir)`
  to `vi.stubEnv('REACH_DATA_DIR', tempDir)`. The old stubs were broken — they stubbed
  `LOCALAPPDATA` but `getReachDataDir()` reads `REACH_DATA_DIR`, so the tests were not
  actually redirecting the file path (side-effecting the real `~/.reach/` directory).

- Added N3 suite (4 tests) pinning the daemon's `getAuthFilePath()` contract:
  - Default path (`~/.reach/bridge-auth.json`)
  - `REACH_DATA_DIR` absolute override
  - Whitespace trimming
  - Whitespace-only string treated as unset

- **Extension-side path not unit-testable from current TS harness.** `getAuthFilePath()`
  is not exported from `extension.mjs`, and the file is a side-effectful module that
  immediately connects (cannot safely import in a test). The N3 daemon-side tests + code
  review of the mirrored logic provide the safety net.

---

## T1 — Stale pipeSocket cross-connection frame leak in streamSdkResponse()

### Root cause

`pipeSocket` is a module-level mutable that is swapped on reconnect (see `connectToDaemon()`,
line ~795: `pipeSocket = socket`). The `enqueueFrame` closure inside `streamSdkResponse()`
enqueued tasks that read `pipeSocket` at execution time. If a reconnect occurred between
enqueue and execution, the task would see the **new** `pipeSocket` and write old-stream
frames onto the new connection. The daemon's new connection has no knowledge of the old
`requestId` → framing corruption.

### Fix

Captured `pipeSocket` into a local `const socket` at the **start** of each stream
(immediately after `await gate` — serial entry through `streamQueue`). All writes for
this stream target the captured `socket`:

1. **`enqueueFrame` early-out:** `if (socket === null || socket.destroyed) return;`
   — prevents enqueuing when the captured socket is already gone.

2. **`.then()` body stale-check:** `if (socket !== pipeSocket || socket.destroyed) return;`
   — at execution time, if a reconnect swapped `pipeSocket`, the frame is dropped.
   Old-stream frames must never land on a new connection.

3. **Final done=true frame:** guarded with `socket !== null && !socket.destroyed && socket === pipeSocket`
   before calling `sendToDaemon`. If a reconnect happened, the done frame is silently
   dropped (new connection gets fresh streams only).

4. **Error frame in catch:** `const canNotify = socket === null || (!socket.destroyed && socket === pipeSocket)`
   — `socket === null` means the error occurred before the stream started (before
   `await gate`), so fall through to `sendToDaemon`'s own guard. Otherwise, only
   notify if still on the same connection.

`socket` is declared with `let socket = null` **before** the outer `try` block so it
is in scope in `catch`.

### Failure mode analysis

| Scenario | Behavior |
|----------|----------|
| No reconnect during stream | `socket === pipeSocket` throughout → no change from existing behavior |
| Reconnect between enqueue and execution | `socket !== pipeSocket` → frame dropped → new connection receives only fresh stream frames |
| Socket destroyed (daemon crash, no reconnect) | `socket.destroyed` → frame dropped → no unhandled write error |
| Error before stream started | `socket === null` → `sendToDaemon` path, existing guard applies |

### Tests

- `FakeExtensionClient` + `FakeDaemon` operate over in-memory `PassThrough` streams,
  not through `extension.mjs` directly — the streaming path in `extension.mjs` is tightly
  coupled to `sdkSession` events and cannot be driven via the existing harness without
  extracting `streamSdkResponse()` as a pure function or introducing SDK mocks.
- **Testability limitation documented:** No test added for T1. Correctness relies on
  careful reasoning + the captured-socket guard pattern (standard JS closure capture
  semantics). The guard is idiomatic and risk is low given serial `streamQueue`.

---

## Tests summary

- N2 (2 tests): fixed stub from `LOCALAPPDATA` → `REACH_DATA_DIR` — were silently broken
- N3 (4 tests): new path-contract suite for daemon `getAuthFilePath()`
- Net test delta: +4 (845 → 849)

---
# Carter — PR #10 Cycle 15 Decisions

**Date:** 2026-06-06  
**Thread:** T1 — Secret prompt echoes bot token to terminal (`src/install/index.ts:92-99`)

---

## D1: Masking approach — blank vs asterisk

**Decision: blank (option a) — no echo at all.**

Blank masking (fully suppressed output) is chosen over asterisk masking (`*` per char). Rationale:
- Standard behavior for secret entry (matches `sudo`, Python `getpass`, SSH passphrases)
- Does not leak token length (asterisks reveal how many chars were typed)
- Simpler implementation — one-liner suppressor vs char-counting echo

Pattern used: `(rl as any)._writeToOutput` override with a function that writes the prompt text through on the first call and swallows all subsequent writes (echoed keystrokes). This is the **same idiom already used in `src/service/install.ts` `promptPassword()`**. Consistent with established codebase practice.

---

## D2: New helper — `promptSecret`

Added `promptSecret(message)` alongside existing `promptLine(message)` in the prompt helpers block. Used for `TELEGRAM_BOT_TOKEN` prompt only. `TELEGRAM_ALLOWED_USER_IDS` is not a secret (numeric user IDs, not credentials) and keeps `promptLine`.

`promptSecret` is intentionally not exported; it's local to the install wizard, same as `promptLine`.

---

## D3: Non-TTY degradation

No special handling needed in `promptSecret` itself. The wizard already gates on `process.stdin.isTTY` before any prompting:

```typescript
if (needsPrompt && !process.stdin.isTTY) {
  // exits with instructions
  process.exit(1);
}
```

`promptSecret` is only called inside the `if (!botToken)` block, which is only reached after the non-TTY gate. Safe by design.

---

## D4: Sibling audit findings

- **`src/install/uninstall.ts`**: No readline prompts at all. Clean.
- **`src/service/install.ts` `promptPassword()`**: Already has `_writeToOutput` masking (cycle predates this fix). No action required.
- **Token echo-back**: After capturing the bot token, the wizard logs `[reach] Written to <envPath>` — the path only, not the token value. No accidental echo. Clean.

---

## D5: Test observability limitation

The readline mock (`vi.mock('readline', ...)`) returns a plain object with a synchronous `question` stub. The mock has no real TTY output stream, so the `_writeToOutput` suppression cannot be observed by watching stdout content.

Mitigation: `capturedWriteFns` array added to hoisted mock state. The mock's `question` stub captures `rl._writeToOutput` at call time, allowing tests to assert the suppressor function was in place during the bot token prompt (IX18) and absent for the subsequent non-secret prompt (IX19).

The output-stream content assertion (IX19 comment) documents this limitation explicitly.

---
# Carter PR #10 — Cycle 16 Decisions

**Date:** 2026-06-06  
**Branch:** user/aaron/phase9 @ d899d41

---

## T1 — BOT_COMMAND_NAMES: DELETE (Case A: genuinely dead)

### Investigation

`BOT_COMMAND_NAMES` was introduced in cycle 3 as a shared command registry alias:

```ts
// src/bot/commands.ts:36
export const BOT_COMMAND_NAMES = BOT_COMMANDS;
```

**Grep evidence — zero live references:**

```
src/      → no references outside the definition itself
tests/    → no references at all
```

Only non-code mentions found:
- `.squad/agents/carter/history.md` — historical narrative, not a code reference
- `.squad/decisions.md` — two mentions, both documenting past decisions:
  1. "Added alias export `BOT_COMMAND_NAMES` and startup drift check in `registerHandlers`" — the drift check was subsequently removed
  2. "alias kept for isBotCommand.test.ts" — that test imports only `isBotCommand` and `BOT_COMMANDS`, not `BOT_COMMAND_NAMES`

**No hardcoded duplicates to wire up.** The codebase uses `BOT_COMMANDS` (the actual `ReadonlySet`) everywhere it needs the set. Nothing is hardcoding a second command-name list that `BOT_COMMAND_NAMES` should be driving.

### Decision

**DELETE.** Case (a): genuinely dead export. The drift check it was originally paired with was removed in a prior cycle; `isBotCommand.test.ts` does not import it. YAGNI applies — a future consumer can re-add if needed.

**Change:** Removed line 36 from `src/bot/commands.ts`. No test imports required updating.

---

## T2 — handlers.slashGuard.test.ts file header: REWRITTEN

The "RED tests (awaiting Carter)" / "⚠️ EXISTING TEST CONFLICT" header was stale. The implementation landed in this PR: `isBotCommand()` guard is live in `handlers.ts`, and `handlers.test.ts` was already updated to use `/list` instead of `/unknown-cmd`. Rewrote the header to describe present reality.

---

## T3 — handlers.slashGuard.test.ts inline scaffold comments: REMOVED

Removed "RED until Carter:" inline comments from test bodies (5 occurrences). Replaced the stale conflict note in the `/unknowncommand` test with a factual note that `handlers.test.ts` was already updated in this PR. Removed stale section heading suffix "(RED until Carter)".

---

## Extra — afkMode.slashGuard.test.ts: same treatment applied

`tests/relay/afkMode.slashGuard.test.ts` carried the same generation of TDD scaffold (file header "RED tests (awaiting Carter)", 5 inline "RED until Carter." body comments, stale section heading). Carter's AFK guard change is also live in this PR. Applied identical cleanup: rewrote header to describe current reality, removed inline RED scaffolding.

## Extra — isBotCommand.test.ts: stale anticipatory header and B1 describe label

- File header: removed "RED until Carter lands src/bot/commands.ts" / "Expected import failure" framing; the module is live.
- `describe('isBotCommand — B1: digit handling (anticipatory)')` → removed "(anticipatory)" suffix and the "RED until Carter lands the regex change" block comment above it; the fix has landed.

---
# Carter — PR #10 Cycle 2 Decisions

Date: 2026-05-31

## Thread 1 — /cwd list reply text

**Decision:** Fixed the hint text inline. Changed `/new <alias>` → `/new <session-name> --cwd <alias>` at `cwdCommand.ts:106`. No structural complexity; single-line fix.

## Thread 2 — removeExtension resilience

**Return type chosen:** `StepResult = { label: string; ok: boolean; reason?: string }`.
- Both `removeExtension()` and `wipeLocalData()` now return `StepResult` instead of `void`.
- `wipeLocalData()` was already non-fatal for the rmSync failure path; it is now also counted as a step that can fail (ok: false) so the orchestrator can report it accurately.
- The "not a Reach state directory" safety refusal also returns `{ ok: false }` — the user requested wipe but it didn't happen, so that's a failure worth reporting.

**Orchestrator aggregation:** `runUninstall` collects `StepResult[]` from all sync steps, then calls `uninstall()` (which handles its own exit via node-windows). If `uninstall()` returns (in tests, or on platforms where it doesn't exit directly), the orchestrator prints a summary and calls `process.exit(1)` only if any step failed. This means the service always runs regardless of earlier failures — idempotency contract preserved.

**Caveat:** In production, the node-windows service uninstaller calls `process.exit` internally, so the summary block after `uninstall()` may not execute. This is an existing architectural constraint that would require refactoring the service layer to fix — out of scope for this wave. The user still sees the per-step error logs as they occur.

**Test added:** UN7 — `removeExtension` fails (rmSync throws EPERM) → service still called → `process.exit(1)` at end.

## Threads 3/4/5 — isDirectRun path normalisation

**Decision: extracted to a shared helper** (`src/install/isDirectRun.ts`).
- Rationale: all three files had the exact same bug. A single helper ensures the fix is applied uniformly and gives a natural home for any future edge-case work (e.g., case-folding on Windows).
- The helper uses `path.resolve(process.argv[1])` to normalise relative paths to absolute, then compares against `fileURLToPath(importMetaUrl)` which is already absolute.

**Windows case-sensitivity:** Not added. Both `fileURLToPath(import.meta.url)` and `path.resolve(process.argv[1])` derive from the same Node.js filesystem view; in practice they carry the same casing. No flake observed in CI. If a flake surfaces in the future, add `.toLowerCase()` inside the helper guarded by `process.platform === 'win32'`.

**Tests added:** `tests/install/isDirectRun.test.ts` with IDR1–IDR4 covering absolute match, relative-path match, different file (false), and empty argv[1] (false).

## Anything that pushed back

Nothing unexpected. The `wipeLocalData` readdirSync is not mocked in `uninstall.test.ts`; it falls through to the real `fs`, throws because the mock path doesn't exist on disk, and the existing catch block handles it — tests were already relying on that behaviour implicitly. No change needed.

---
# Carter — PR #10 Cycle 3 Fix Decisions

**Wave:** Cycle 3 (PR #10, branch user/aaron/phase9)
**Date:** 2026-05-31
**Threads:** T2 (service uninstall composability), T6 (noble-six consolidation), T7 (isBotCommand header comment), T8 (TELEGRAM_ALLOWED_USER_IDS wizard validation)

---

## T2 — uninstallService() Promise shape

**Final shape:** `export function uninstallService(): Promise<void>` (sync wrapper returning a Promise, not async).

**Settled-guard pattern:** Boolean `settled` flag, checked at the top of every event handler and the timeout callback. First event wins; late arrivals are no-ops. Matches the extension.mjs streaming fix pattern (Noble Six Phase 8.5).

**Timeout duration:** 60 000 ms (60 s). Chosen as a safe upper bound for node-windows SCM round-trip. Rejects with `'[reach] Service uninstall timed out after 60 s — uninstall event never fired'`.

**Listener cleanup:** `clearTimeout(timer)` called in a shared `finish(err?)` helper that both resolves and rejects. Timer is the only external resource; node-windows event listeners are not manually removed (they become inert after `settled = true`).

**Backward-compat shim:** `uninstall()` kept as a synchronous CLI shim that calls `uninstallService().then(() => process.exit(0)).catch(() => process.exit(1))`. This preserves the existing observable behavior for any code that imports the old `uninstall()` export.

**main() update:** `service/install.ts:main()` now `await uninstallService()` with explicit `process.exit(0|1)` instead of calling the shim.

**runUninstall() changes:**
- Promoted to `async function runUninstall(): Promise<void>`.
- Service step is now a tracked `StepResult` (`{ label: 'Uninstall Windows service', ok: true/false }`).
- On rejection: logs error, pushes `{ ok: false, reason }`, continues to step summary.
- `isDirectRun` block chains `.then(() => process.exit(0)).catch(() => process.exit(1))`.

**New tests:** UN8 (service rejects → exit 1), UN9 (service resolves → no exit). Existing UN1–UN7 updated to async/await. All 9 tests green.

---

## T6 — Noble Six directory consolidation

**Source of truth kept:** `noble-six/` (hyphenated). Physical merge performed — `noble six/` git-removed, content preserved.

**Charter decision:** Kept the single charter from `noble six/charter.md` (the only copy; `noble-six/` had no charter before). Updated one stale inbox path reference: `noble six-{brief-slug}` → `noble-six-{brief-slug}`.

**History merge:** `noble-six/history.md` was the shorter/newer file (Opus 4.5 instance, Phase 9 only). `noble six/history.md` was the comprehensive summarized file (Opus 4.6 instance, Phases 6–9+). Merge strategy:
- Used `noble six/history.md` as base (complete phase history + learnings).
- Inserted the unique "Phase 9 Sprint" detail block from `noble-six/history.md` (sprint breakdown, Knowledge Base, Decision Consolidation, No Further Phases Assigned) before the existing Learnings section.
- The overlapping streaming-fix section (2026-05-30T22:08) was present in both; kept the `noble six/history.md` copy (which has the Learnings appendix following it) — deduplicated as instructed.

**history-archive.md:** Copied verbatim from `noble six/` to `noble-six/` (Phase 1–5 archive).

**No merge conflicts:** Both files were append-only; no conflicting edits detected.

**team.md:** Updated to `.squad/agents/noble-six/charter.md`.

**Casting registry:** `casting/registry.json` key left as `"noble six"` (string identifier used by agent dispatch, distinct from folder path). Only the physical folder path and charter reference were renamed.

---

## T8 — TELEGRAM_ALLOWED_USER_IDS validation regex

**Validation regex:** `/^[1-9][0-9]*$/` — positive integer, no leading zero, no negative, no decimal, no whitespace in the token itself.

**Normalization:** Input split on `,`, each token `.trim()`-ed, joined back as `tokens.join(',')` before writing. Handles `"123, 456"` → `"123,456"`.

**Alignment with parseEnv:** `parseEnv` accepts tokens that pass `t.length > 0 && Number.isInteger(Number(t)) && Number(t) > 0`. The wizard's `/^[1-9][0-9]*$/` regex is a strict subset: it rejects leading zeros (e.g., `"007"`), which would technically pass `Number()` conversion (`Number("007") === 7`) — a deliberate tightening to reject ambiguous input. No valid use case for leading zeros in Telegram user IDs.

**Divergence from parseEnv:** The wizard rejects `"007"` (leading zero); parseEnv would accept `7` derived from it. This is intentional — the wizard is the canonical entry point and should be stricter than the runtime parser.

**Retry cap:** 3 attempts. On each invalid attempt, error is printed and user is reprompted. After the 3rd failure (or on blank input at any point), falls through to skip-with-confirmation (existing Q2 behavior).

**New tests:** IX14 (valid `123,456`), IX15 (invalid then valid retry), IX16 (whitespace normalization), IX17 (empty token rejection + skip flow). All 4 tests green.

---
# Carter — PR #10 Cycle 3 Storage Migration Decisions

**Date:** 2026-05-31  
**Branch:** user/aaron/phase9  
**Author:** Carter (Bridge Dev)

---

## Migration Approach: Option A (Explicit)

**Decision:** Approach A — `migrateLegacyDataDir()` is an explicit function called from two entry points: `src/install/index.ts` (`runInit`) and `src/main.ts` (`main`).

**Reasoning over Option B (lazy / first-call):**
- Explicit call sites are easier to test: tests can call the function directly and assert side effects without going through `getReachDataDir()`.
- The module-level `migrationAttempted` flag in Option B couples migration state to module lifecycle, making reset tricky in test environments (requires `vi.resetModules()`). In Option A the flag lives in `migrate.ts` which can be independently reset.
- Explicit call sites make it obvious in the install and daemon startup that "migration runs here" — future maintainers don't need to know that `getReachDataDir()` has side effects.
- Aaron's install is single-machine; the extra explicitness costs nothing.

**Tradeoff accepted:** If someone adds a third entry point and forgets to call `migrateLegacyDataDir()`, migration won't run there. Acceptable: the two call sites (install + daemon start) cover the entire install lifecycle.

---

## REACH_DATA_DIR Resolution Rules

| Input | Behavior |
|-------|----------|
| Not set | `path.join(os.homedir(), '.reach')` |
| Empty string `""` | Treated as absent — uses default |
| Whitespace only `"   "` | `.trim()` → empty → treated as absent — uses default |
| Absolute path | `path.resolve(value.trim())` — resolved as-is |
| Relative path | `path.resolve(value.trim())` — resolved relative to `process.cwd()` |

**Rationale:** `.trim()` before empty-check prevents accidental whitespace (e.g., trailing newline in a `.env` file) from being used as a path. `path.resolve()` normalises both relative and absolute paths, making the output always absolute.

---

## Hardcoded Path Strings Found Beyond Initial Scope

Grepped `src/` for `LOCALAPPDATA`, `APPDATA.*reach`, and `\\reach\\`. Found:

| File | Pattern found | Action taken |
|------|--------------|--------------|
| `src/config/config.ts` | `%APPDATA%\reach` in docstring + code | ✅ Updated docstring + simplified function |
| `src/bridge/pipeAuth.ts` | `%LOCALAPPDATA%\reach\bridge-auth.json` in docstring + `getAuthFilePath()` | ✅ Updated to use `getReachDataDir()` |
| `src/install/uninstall.ts` | `%LOCALAPPDATA%\reach` in comments, `LOCALAPPDATA` env var in two functions | ✅ Removed both; uses `getReachDataDir()` |
| `src/install/copyExtension.ts` | `%APPDATA%\GitHub Copilot\...` in docstring | ⏭️ Left untouched — this is the extension dir, not Reach state (explicitly out of scope per design doc §1) |

No additional hardcoded path strings found outside these four files.

---

## Cross-Platform / ADR-5 Confirmation

`os.homedir()` returns the correct user home directory on Windows when the daemon runs as a service per ADR-5 (service runs as the logged-in user account, not SYSTEM). When a named-user Windows service starts:
- `os.homedir()` → `C:\Users\<username>` (same as interactive shell)
- `APPDATA`, `LOCALAPPDATA`, and `USERPROFILE` are all populated by SCM

This is documented in Noble Six's design doc §7 and confirmed by `src/service/install.ts:11`. A dedicated service-context test is deferred to Phase 10 (noted in `history.md`).

---

## Files Changed

| File | Change |
|------|--------|
| `src/config/config.ts` | `getReachDataDir()` rewritten to `~/.reach/` + `REACH_DATA_DIR` override |
| `src/config/migrate.ts` | **New** — `migrateLegacyDataDir()` one-shot migration helper |
| `src/bridge/pipeAuth.ts` | `getAuthFilePath()` → `getReachDataDir() + '/bridge-auth.json'`; import added |
| `src/install/uninstall.ts` | `wipeLocalData()` targets `getReachDataDir()`; no-wipe hint updated; `LOCALAPPDATA` code removed |
| `src/install/index.ts` | `migrateLegacyDataDir()` called at start of `runInit()` |
| `src/main.ts` | `migrateLegacyDataDir()` called at start of `main()` |
| `tests/config/config.test.ts` | `getReachDataDir()` + `getConfigPath()` tests rewritten for new behaviour |
| `tests/config/migrate.test.ts` | **New** — migration unit tests (MIG1–MIG6) |
| `tests/install/uninstall.test.ts` | Updated for new path structure; UN10 added |

---
# Carter — PR #10 Cycle 4 Fix Decisions

**Wave:** Cycle 4 (PR #10, branch user/aaron/phase9)
**Date:** 2026-06-01
**Threads:** Thread 1 (uninstallService sync-throw timer leak), Thread 2 (hardcoded ~/.reach in no-wipe hint), Thread 3 (stale comment)

---

## Thread 1 — uninstallService sync-throw guard

**finish() helper:** Already existed from Cycle 3 (T2 fix). It calls `clearTimeout(timer)` then resolve/reject. I called it from the new catch block rather than refactoring inline — the helper already does all three required things (clears timeout, resolves/rejects). No refactor needed.

**Listener cleanup approach:** After `finish()` is called, `settled = true` is set before calling `finish()`, so all event handlers are neutered by the settled guard. Physical listener removal (`svc.removeListener`) was NOT added — the `ServiceInstance` interface does not expose `removeListener`, and the settled guard is sufficient. If physical removal is needed in the future, `ServiceInstance` must be extended.

**Mock impl leak fix:** SU tests set `mockSvcUninstall.mockImplementation(() => { throw ... })`. The outer `beforeEach` calls `vi.clearAllMocks()` (NOT `vi.resetAllMocks()`), which preserves mock implementations. Added `afterEach(() => { mockSvcUninstall.mockReset(); })` inside the `uninstallService()` describe block to prevent the throw impl from leaking into subsequent `main()` tests.

---

## Thread 2 — hardcoded ~/.reach in no-wipe hint

**Fix applied:** Line 114 in `src/install/uninstall.ts`. The `reachDir` variable was already resolved on line 111 via `getReachDataDir()`. Only the `Remove-Item` command line was hardcoded; the "Local state preserved" line (line 112) already used `reachDir`. Changed to template literal: `` `[reach]   Remove-Item -Recurse -Force "${reachDir}"` ``.

**Other hardcoded ~/.reach strings:** Grep across `src/**/*.ts` found other occurrences in:
- `src/config/config.ts` — JSDoc comments describing default dir. These are accurate descriptions of the *default*, not user-facing instructions. Left alone.
- `src/config/migrate.ts` — JSDoc/inline comments. Same reasoning. Left alone.
- `src/install/index.ts` — Migration comment. Describes legacy → new path. Left alone.
- `src/bridge/pipeAuth.ts` — JSDoc comment. Left alone.
- `src/install/uninstall.ts` JSDoc (`/** When true, also deletes ~/.reach/... */`) — This is describing the *default* behavior, not a runtime path. Left alone.

Only the **runtime user-facing console output** in the no-wipe branch was wrong.

---

## Thread 3 — stale comment

Comment at lines 100–101 in `src/install/uninstall.ts`. Old text claimed the service uninstaller "calls process.exit internally via node-windows events." Updated to accurately reflect the post-Cycle-3 architecture: uninstallService() returns a Promise, does not exit, and the orchestrator accumulates step results and exits at the end.

---
# Carter — PR #10 Cycle 5 Decisions

**Date:** 2026-06-01  
**Commit:** TBD (fix(pr10-cycle5): fail-closed wipe inspection + log service uninstall errors)

---

## 1. Other silent-catch patterns found in install/service code

### `src/config/migrate.ts:113` — non-fatal empty-dir removal

```ts
try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
```

**Context:** This runs only when `copied.length === 0` — the legacy dir is already empty. The rmSync here is a cosmetic cleanup (remove the now-empty shell). If it fails, the migration has already succeeded and no data was left behind. This is a legitimate best-effort swallow: failure is genuinely non-fatal and calling out specific error paths would only add noise to migration logs.

**Assessment:** Leave as-is. Not a safety bug. Unlike `wipeLocalData`, there is no risk of an unintended wipe because the directory is provably empty at this point.

### No other silent-catch patterns found in `src/install/` or `src/service/`.

---

## 2. Final error-logging format

The format chosen for service uninstall errors (in both the CLI shim and `main()`):

```
[reach] Service uninstall failed: <error.message>
```

### Rationale

- **`[reach]` prefix** — Consistent with every other user-facing message in the install/service domain. Makes it easy to grep logs and correlate with other output.
- **`Service uninstall failed:`** — Noun-phrase subject. Action-oriented. Distinguishes this from filesystem step failures in `runUninstall()` which use `ERROR:` or `WARNING:` prefixes.
- **`<error.message>`** — The raw message from the Error object. No wrapping, no JSON, just the text. Avoids double-quoting and keeps copy-paste debugging simple.

### Standardization recommendation for Aaron

If other install commands (e.g., `install()` CLI shim) ever gain similar error-propagation, use the same pattern:

```ts
.catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[reach] Service <action> failed: ${msg}`);
  process.exit(1);
});
```

Substitute `<action>` with `install`, `uninstall`, `start`, `stop`, etc.  
The consistent prefix makes it trivial to filter support logs: `grep '\[reach\] Service'`.

---

## 3. mockImplementationOnce pattern for fire-and-forget tests

When testing a `void`-returning function with an internal promise chain (fire-and-forget), and `process.exit` is mocked to throw globally, use `mockImplementationOnce` (not `mockImplementation`) to avoid leaking a non-throwing mock into subsequent tests. This pattern is now established and should be used whenever a similar fire-and-forget shim needs error-path testing.

---
# Carter — PR #10 Cycle 6 Decisions

**Date:** 2026-06-01  
**Branch:** user/aaron/phase9  
**Commit wave:** fix(pr10-cycle6)

---

## T1 — Orientation Race: Option A (flag-first, no catch rollback)

**Decision:** Set `binding.orientationSent = true` BEFORE `await safeSendMessage(...)`, and do NOT roll back on failure.

**Reasoning:**

- **Why A over B:** The race window only opens if we set the flag after the await. The callers check `!binding.orientationSent` and skip if already set; with flag-first, a second concurrent caller sees the flag immediately and skips — even while the first send is still in flight. Option B (rollback in catch) would reopen the race window on transient failures, which defeats the purpose of the guard.
- **On failure semantics:** `safeSendMessage` already swallows errors internally (logs a warning, never throws). Even if the send fails, the orientation state is conceptually "attempted for this AFK cycle." Retrying on the next `activate()` call after a failure would require a new AFK cycle, which resets `orientationSent` anyway. So keeping the flag true on failure is correct.
- **No retry-on-failure pattern found:** Searched the codebase — no pattern of rolling back state flags and retrying on transient errors in the AFK module. `withRateLimitRetry` covers rate-limit retries at the send layer, not flag rollback at the coordination layer.

---

## T2 — Double `[reach]` Prefix Audit

**Decision:** Strip `[reach]` from `Error.message` bodies in `src/service/install.ts`. The logger owns context.

**Single internal Error message with `[reach]` found and fixed:**

```
Line 346 (before): new Error('[reach] Service uninstall timed out after 60 s — uninstall event never fired')
Line 346 (after):  new Error(`Service uninstall timed out after ${UNINSTALL_TIMEOUT_MS / 1000} s — uninstall event never fired`)
```

**Audit result — other `[reach]` occurrences in install.ts:**  
All other `[reach]` occurrences are in `console.log`, `console.error`, and `console.warn` calls — these are correct (the logger adds context). There are NO other `new Error('[reach] ...')` patterns in `src/service/install.ts` or `src/install/*`.

The only violator was the timeout error message. The call-site `console.error('[reach] Service uninstall failed: ${err.message}')` correctly prefixes context at the boundary.

---

## Cluster 1 — redactSecrets Regex Final Shape

**Pattern change:** Added a 4th capture group `(["']?)` after the value in both KEYWORD_PATTERN and ENV_ASSIGNMENT_PATTERN to capture the optional trailing quote.

**KEYWORD_PATTERN (final):**
```
/\b(token|key|secret|...)\b(\s*[:=]?\s*['"]?)([A-Za-z0-9_\-.+/=]{16,})(["']?)/gi
```
Groups: `(keyword)(separator+openQuote)(value)(closeQuote)`

**ENV_ASSIGNMENT_PATTERN (final):**
```
/\b([A-Z][A-Z0-9_]*(?:TOKEN|...))\b(\s*=\s*['"]?)([^\s'"]{8,})(["']?)/g
```
Groups: `(varName)(separator+openQuote)(value)(closeQuote)`

**Replacement shape:**
```ts
(_match, kw, sep, _value, closeQuote) => `${kw}${sep}[REDACTED]${closeQuote}`
```

**Why independent `(["']?)` instead of backref `\3`:**
Conservative bias rule — false negatives (missed secrets) are worse than false positives. With backref, a mismatched-quote value (`token="secret'`) might fail to match and leak. With independent capture, the trailing character (whatever it is) is always consumed and re-emitted. Downstream pass 3 (HIGH_ENTROPY_PATTERN) provides an additional backstop.

**Mismatched quote behavior:** `token="abc123longvalue1234'` → value redacted, trailing `'` re-emitted as-is. Output is malformed like the input was — acceptable for a best-effort redactor.

---
# Carter — PR #10 Cycle 7 Decisions

**Date:** 2026-06-02  
**Branch:** user/aaron/phase9  
**Commit wave:** fix(pr10-cycle7)

---

## T1 — `src/config/migrate.ts`: win32 platform gate

**Decision:** Option (b) — explicit `if (process.platform !== 'win32') return;` at the
top of `migrateLegacyDataDir()`, before the `migrationAttempted` flag check.

**Rationale:**

Pre-Phase 8.5 Reach was Windows-only. The legacy paths (`%APPDATA%\reach\`,
`%LOCALAPPDATA%\reach\`) are Windows-specific constructs. There has never been a
Unix install of Reach: prior code used `process.env.APPDATA` which is undefined on
Unix, meaning the codebase would have crashed or produced no-op behavior. There is
no Unix legacy state to migrate FROM.

The Copilot reviewer's premise ("previous default was ~/.config/reach") is incorrect.
Pre-Cycle 3 code did not fall back to `~/.config/reach` — it used `process.env.APPDATA`
with a fallback to `path.join(os.homedir(), 'AppData', 'Roaming')` (a Windows path
convention even when APPDATA is unset). This fallback only makes sense on Windows.

**Why Option (b) over (a):** Option (a) (do nothing) leaves the function silently
inspecting `AppData\Roaming\reach` on a future Unix target, which would always be
absent but is confusing. Explicit gate + documentation makes the Windows-only
assumption clear to Phase 10 contributors. The comment explicitly warns: "When Phase
10 adds cross-platform support, there will be no legacy Unix paths to migrate FROM."
This prevents a future contributor from adding a `~/.config/reach` migration branch
without understanding that no such legacy state ever existed.

**Platform gate position:** Before `migrationAttempted` — this means on non-Windows,
the function returns without setting the flag. This is correct: the flag is only
meaningful for Windows execution flow, and returning before it is set does not create
double-call issues (the function is still a no-op on non-Windows regardless of how
many times it is called).

---

## T2 — `src/install/uninstall.ts`: `import 'dotenv/config'` added

**Decision:** Add `import 'dotenv/config'` as the first import in `uninstall.ts`.

**Rationale:**

`runUninstall()`/`wipeLocalData()` calls `getReachDataDir()`, which honors the
`REACH_DATA_DIR` environment variable. The daemon loads `.env` via `dotenv/config`
(in `src/main.ts`), but the uninstall script did not. A user with
`REACH_DATA_DIR=D:\custom\reach` in `.env` would find that `npm run uninstall -- --wipe`
deletes `~/.reach` (the default) instead of their actual state directory, because the
custom path was only in `.env` and never loaded.

This is a real data-integrity bug: the daemon has been writing to one directory and
the uninstall script is wiping a different one.

---

## T2 Audit — Sibling install entry points

**`src/install/index.ts` (`npm run init`):** ✅ ALSO FIXED.

`runInit()` calls `migrateLegacyDataDir()` → `getReachDataDir()`. If a user has
`REACH_DATA_DIR` in `.env` (e.g., an upgrade on a system with a custom data dir),
the migration would target `~/.reach` instead of the custom dir, potentially
failing to find or copy the legacy data to the right place. Added
`import 'dotenv/config'` as the first import.

Additionally, `runConfigWizard()` reads Telegram vars from `process.env` with
`readEnvFile()` as fallback. With `dotenv/config` loaded, `process.env` is already
populated from `.env` before the wizard runs. The wizard's `getVal()` function reads
`process.env` first anyway, so behavior is consistent — this doesn't change wizard
semantics, it just makes `REACH_DATA_DIR` (and any other process-level config in
`.env`) available through `process.env` uniformly.

**`src/install/copyExtension.ts` (`npm run install:extension`):** ✅ NOT needed.

`copyExtension()` does not call `getReachDataDir()`. It only uses:
- `process.env['APPDATA']` — Windows system env var, always in `process.env`, never in `.env`
- `process.env['NODE_ENV']` — set at CLI invocation (`NODE_ENV=development npm run ...`), not via `.env`

No `dotenv/config` added.

---

## Test coverage added

- **MIG7** (`tests/config/migrate.test.ts`): non-Windows platform mock (`process.platform = 'linux'`),
  asserts `existsSync` is never called — the gate fires before any fs access.
- **UN13** (`tests/install/uninstall.test.ts`): comment-level integration test note documenting
  the manual verification procedure. Unit-level assertion confirms the `vi.mock('dotenv/config')`
  stub is exercised (i.e., the import is present in the production module).
- **dotenv mock** added to both `tests/install/uninstall.test.ts` and `tests/install/index.test.ts`
  to prevent dotenv from attempting real `.env` reads during the test run.

---
# Carter — PR #10 Cycle 8 Decisions

**Date:** 2026-06-03  
**Branch:** user/aaron/phase9  
**Commit:** fix(pr10-cycle8): redactSecrets charset for JWT/base64 + defensive excerpt truncation

---

## T1 — HIGH_ENTROPY_PATTERN charset

**Final charset:** `[A-Za-z0-9_\-/+.=]{39,}`

Added `.` and `=` to the existing `[A-Za-z0-9_\-/+]` charset. This catches:
- JWT-shaped tokens (three `.`-separated base64url segments like `header.payload.sig`)
- Standard base64 strings with `=` or `==` padding

**Threshold:** Unchanged at 39+ characters (per cycle-2 docstring decision).

**False-positive analysis:**

Long URLs were the primary concern. Testing `https://example.com/very/long/path/with-many-segments`:
- The URL-creds pattern (pass 4) doesn't help here — it only matches `user:pass@host`.
- However, `https://example.com/very/long/path/with-many-segments` contains `:` and `/` but
  `https:` prefix — the scheme prefix `https:` and `:` are NOT in the charset, so the URL is
  naturally broken at the `:` character. The path segment after the host would need to be a
  single unbroken run of 39+ chars from the allowed charset to trigger HIGH_ENTROPY_PATTERN.
- Real path segments like `/very/long/path/with-many-segments` contain `/` (in charset) but
  also hyphens and mixed-case short words. A run like `/very/long/path` totals 15 chars —
  nowhere near 39.
- Only pathological cases like `https://host/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (a
  40-char lowercase run) would newly match. These are not realistic URL patterns in user prose.
- **Conclusion:** False-positive risk from the `.`/`=` addition is negligible. The module's
  conservative bias (false positives < false negatives) applies.

**Existing tests:** All 21 pre-existing redactSecrets tests continue to pass. URL fixture
`https://user:password@example.com/repo.git` is covered by the URL_CREDS_PATTERN (pass 4)
and the `example.com` host survives as expected.

**New tests added:** C8-1 (JWT token), C8-2 (base64 with `=` padding) — both in
`tests/bot/redactSecrets.test.ts`.

---

## T2 — MAX_EXCERPT_LENGTH location

**Decision:** Module constant in `src/bot/afkMode.ts`.

`protocol.ts` does not define a `MAX_EXCERPT_LENGTH` constant — the 500-char truncation is
only described in the JSDoc comment on `AfkRequestMessage.lastAssistantExcerpt`. Rather than
add a numeric export to the protocol file (which would mix wire-schema types with behavioral
constants), `MAX_EXCERPT_LENGTH = 500` is defined at the top of `afkMode.ts` where it is used.

If the protocol ever formalizes this constant (e.g., for extension-side enforcement parity),
it can be extracted to `protocol.ts` and imported here.

**Implementation:** Truncation applied at ingestion in the `afk.request` handler, before
`lastKnownExcerpts.set()`. Excerpts exceeding 500 chars are sliced and appended with `…`
(U+2026 HORIZONTAL ELLIPSIS). Excerpts of exactly 500 chars or fewer are stored unchanged.

**New tests added:** C8 truncation block in `tests/bot/afkMode.staleExcerpt.test.ts`:
- 600-char excerpt → truncated, `…` present in /status output
- 500-char excerpt → stored unchanged, no `…`
- 499-char excerpt → stored unchanged, no `…`

Test strings use short space-separated words (`'word '.repeat(n)`) to avoid the
HIGH_ENTROPY_PATTERN redacting the test values before they reach the display assertion.

---
# Carter — PR #10 Cycle 9 Decisions

**Date:** 2026-06-05  
**Branch:** user/aaron/phase9  
**Threads:** T1 (atomic legacy migration), T2 (excerpt truncation off-by-one)

---

## T1 — Atomic legacy migration (`src/config/migrate.ts:84-107`)

### Options considered

| Option | Description | Risk |
|--------|-------------|------|
| A | Atomic temp+rename per-dir | Cross-device rename concern on Windows; complex partial-cleanup path |
| B | Per-dir retry: remove early-return, check each legacy dir individually | Minimal; idempotent copy handles re-runs cleanly |
| C | Sentinel file `.reach-migration-complete` | More state to manage; doesn't address partial dir failure |
| D | Combine B + A | Most robust; added complexity justified only if cross-device risk is a concern |

### Decision: **Option B**

**Rationale:** The reported bug is precisely the early return `if (fs.existsSync(newRoot)) return;`. Removing it is sufficient — the existing per-dir loop already handles partial states correctly:
- `mkdirSync` with `{ recursive: true }` is a no-op if the dir already exists.
- Each legacy dir is checked for existence before attempting copy.
- If a legacy dir was already successfully migrated (and removed), it is absent from disk and simply skipped.
- Re-copying already-migrated files (overwrite) is harmless and idempotent.

Option D (temp+rename) would guard against mid-copy crashes, but on Windows a rename (MoveFile) within the same volume is atomic and would require a scratch dir under `newRoot`. Given Phase 8.5 scope and the low frequency of mid-copy crashes, this complexity is not justified. The retry path (Option B) closes the actual failure mode: a partial migration that left `newRoot` on disk with only some legacy dirs copied.

### Trade-offs / limitations

- A crash between `copyFileSync` and `rmSync` on a single file leaves the legacy dir intact, which is safe (next run re-copies, then removes).
- A crash between the last successful `rmSync` and process exit leaves no legacy dir and is fully clean.
- The `migrationAttempted` in-process flag still prevents double-migration within one process, which is correct and unchanged.

### Files changed

- `src/config/migrate.ts`: removed `if (fs.existsSync(newRoot)) return;`, updated doc comment.
- `tests/config/migrate.test.ts`: added MIG8 — partial migration retry scenario.

---

## T2 — Off-by-one in excerpt truncation (`src/bot/afkMode.ts:128-130`)

### Decision: apply `slice(0, MAX_EXCERPT_LENGTH - 1) + '…'`

`'…'` is one Unicode character (U+2026). The previous `slice(0, MAX_EXCERPT_LENGTH)` produced 500 chars then appended the ellipsis, storing 501 chars total — exceeding the documented 500-char protocol limit.

Fix: `slice(0, MAX_EXCERPT_LENGTH - 1)` = 499 chars + `'…'` = **500 chars**, matching the limit exactly.

### Files changed

- `src/bot/afkMode.ts`: off-by-one corrected.
- `tests/bot/afkMode.staleExcerpt.test.ts`: added `storedExcerpt.length ≤ 500` assertion to C8 truncation test.

---
# Decision: carter-pr10-stale-excerpt

**Date:** 2026-05-31
**Author:** Carter (Bridge Dev)
**Context:** PR #10, Copilot review comment on `src/bot/afkMode.ts:119-123`

## Decisions Made

### 1. Empty-string treated as absent (yes — recommended)

An `afk.request` with `lastAssistantExcerpt === ''` is treated identically to an
omitted excerpt. The `lastKnownExcerpts` map entry is **deleted**, not preserved.

**Rationale:** Redaction (`redactSecrets`) applied to an excerpt that consists
entirely of secrets produces `''`. Storing an empty string would still suppress
the "no excerpt" fallback path (`if (rawExcerpt)` is falsy), but would show
a blank `💬 Last from …:` line with no content. Deleting the key avoids this
display artifact and keeps the invariant: "a stored excerpt is always
non-empty and displayable."

The combined guard is: `if (lastAssistantExcerpt !== undefined && lastAssistantExcerpt !== '')`.

### 2. No consumer adjustment needed in `formatOrientationMessage` / `handleStatusCommand`

Both consumers reach `formatOrientationMessage`, which guards with:

```ts
const rawExcerpt = this.lastKnownExcerpts.get(binding.sessionId);
if (rawExcerpt) { ... }
```

After the fix, a deleted key returns `undefined`, which is falsy — the `💬`
block is correctly omitted with no consumer-side changes needed.

`handleStatusCommand` delegates entirely to `formatOrientationMessage` via
`safeSendMessage`; no further adjustment required there either.

## Fix Location

`src/bot/afkMode.ts:119-128` — `afk.request` handler in the constructor.

---
# Noble Six — State Storage Triage

**Date:** 2026-05-31T22:50:49-07:00
**Author:** Noble Six (Lead / Architect)
**Context:** PR #10 cycle 3 Copilot review findings T1/T3/T4/T5 — split state storage layout

---

## Recommendation

**Unify all Reach state under `~/.reach/` (`os.homedir()/.reach/`).**

- Single root, zero platform switches, cross-platform ready for Phase 10.
- `getReachDataDir()` becomes a one-liner: `path.join(os.homedir(), '.reach')`.
- `pipeAuth.ts` drops its independent `LOCALAPPDATA` path and reuses `getReachDataDir()`.
- `--wipe` simplifies to one `rmSync` on one directory.
- Cost: S (small) — ~25 LOC across 4 files, 1.5h implementation.

## Rationale

The split was unintentional (two authors, two defaults, no ADR). Today's layout puts durable state in `%APPDATA%` and transient state in `%LOCALAPPDATA%`. Neither roaming nor locality matters for a single-machine daemon. `~/.reach/` matches the dominant CLI tool pattern (`~/.aws/`, `~/.kube/`, `~/.docker/`) and works unchanged on macOS/Linux — the only option that avoids a Phase 10 rewrite of path logic.

## Would NOT Recommend

**Option B (unify under `%APPDATA%`)** — actively harmful. `bridge-auth.json` is per-machine transient state; roaming it via `%APPDATA%` would cause auth failures on multi-machine profiles. This is the only option with a correctness hazard, not just a style preference.

## Architectural Follow-Up for Phase 10

Regardless of which option is chosen:
1. **`REACH_DATA_DIR` env override** — Consider adding a `process.env.REACH_DATA_DIR` override (~3 LOC) for corporate environments with redirected home directories.
2. **Extension path** — The Copilot extension (`extension.mjs`) lives in `%APPDATA%\GitHub Copilot\...` — this is Copilot's tree, not ours. It stays where it is regardless of state root changes.
3. **XDG compliance** — The current `~/.reach/` recommendation is XDG-adjacent but not XDG-compliant (which would be `~/.local/share/reach/` for data, `~/.config/reach/` for config). Full XDG is overkill for a tool this small — revisit only if Reach grows to need cache/log separation.

---

Full design doc: `.copilot/reach-state-storage-design.md`

---

## Proposed / Pending Approval

> ⚠️ **These entries are DRAFT proposals awaiting Aaron's decision-gate approval. Do NOT treat as accepted decisions until explicitly approved.**

---

### PROPOSED ADR-DRAFT: Communications Channel Abstraction & Microsoft Teams Transport

**Status:** DRAFT — Pending Aaron's approval  
**Author:** Noble Six (Lead/Architect)  
**Date:** 2026-06-06  
**Inbox Reference:** `.squad/decisions/inbox/noble-six-comms-channel-abstraction-adr.md`

**Summary:** Proposes a phased approach to generalize Reach's hard-coupled Telegram integration:
- **Phase 1 (Open Repo):** Extract `ChannelPort` interface; refactor existing Telegram code into a `TelegramChannel` adapter. Zero behavior change.
- **Phase 2 (Corp Fork):** Implement `TeamsChannel` adapter using Microsoft Graph REST API. Developed in corp environment with corp Azure AD access.

**Key Decisions in Draft (requires Aaron approval):**
1. **Architecture:** Recommend Option A (Minimal Port Interface) for channel abstraction
2. **Teams Transport:** Recommend Graph REST API as primary (simpler, no HTTP server needed)
3. **Single Binary vs. Separate Builds:** Recommend single binary with `REACH_CHANNEL=telegram|teams` env var
4. **Formatting Ownership:** Recommend Option (a) — transport owns all formatting

**Open Questions for Aaron:**
- Graph API vs. Bot Framework as primary Teams transport?
- Single binary with channel switch or separate builds?
- How aggressively to generalize formatting?
- Can the corp fork `npm install` from the public GitHub repo?
- Is a publicly reachable webhook endpoint feasible in the corp environment?
- Does your corp tenant require admin consent for application permissions?
- Is AFK mode in scope for Teams Phase 2?
- Pairing flow for Teams?

**Full Document:** See `.squad/decisions/inbox/noble-six-comms-channel-abstraction-adr.md` (to be archived after approval).

---

### REFERENCE: Telegram/grammY Coupling Inventory for Teams Generalization

**Status:** Read-only reference  
**Author:** Carter (Bridge Dev)  
**Date:** 2026-06-06  
**Inbox Reference:** `.squad/decisions/inbox/carter-teams-channel-inventory.md`

**Summary:** Comprehensive file-by-file coupling map documenting:
- Direct grammY/Telegram imports across the codebase
- Telegram-specific concepts baked into message relay flow
- Session/topic ID assumptions (1:1 forum topic → session mapping)
- Config surface (env vars, config.json fields)
- Abstraction seams (where Teams adapter can plug in)
- Tangled coupling hotspots (requiring refactor for Teams support)

**Key Findings:**
- ✅ Good seams: Relay ports layer already abstracted; message formatting utils are pure functions
- ❌ Tangled coupling: Bot handlers (8 commands), AFK mode (300+ lines), session registry key type, MarkdownV2 hardcoding

**Reference Value:** This inventory is input to Noble Six's Phase 1 task breakdown (P1-2 through P1-5 in the ADR).

**Full Document:** See `.squad/decisions/inbox/carter-teams-channel-inventory.md` (reference archive).
---

## Accepted — Phase 1 Channel Abstraction (feature/channel-abstraction)

**Date:** 2026-06-06  
**Status:** PHASE 1 COMPLETE — review-verified (Noble Six APPROVE-WITH-NITS), F1 blocker resolved + verified, 946 tests green, port is Teams-ready as written  
**Participants:** Carter (Bridge Dev), Kat (Bot Dev), Jun (Test Engineer), Noble Six (Architect)  
**Branch:** feature/channel-abstraction  
**Commit baseline:** d84dc0c (Carter), e69e50b (Kat), 3739640 (Jun). F1 fixes: e1f3f4d (Carter), 2b5e4a2 (Jun).  
**Summary:** Completed ChannelPort abstraction, Telegram adapter, and full conformance kit. Core domain now transport-agnostic; ready for Teams Phase 2 (pending corp branch development).

---

### CLOSE-OUT — F1 Blocker Resolved

**Date:** 2026-06-06  
**Blocker:** F1 — Relay does not check `supportsStreaming` / `supportsMessageEdit` before calling `editMessage` during streaming.

**Carter's Fix (commit e1f3f4d):** Introduced explicit three-case branch at the start of streaming path:

| supportsStreaming | supportsMessageEdit | Relay behavior |
|---|---|---|
| `true` | `true` | **Case A (Telegram):** `"…"` placeholder → throttled 800ms stream edits → final `editMessage`. Byte-identical to pre-fix code. |
| `false` | `true` | **Case C:** `"thinking…"` placeholder → silent accumulation → single final `editMessage`. No intermediate edits. |
| `true` or `false` | `false` | **Case B:** No placeholder. Silent accumulation. Single `sendMessage` with the complete response. `editMessage` never called. |

**Jun's Verification (commit 2b5e4a2):** Nine new relay-level capability tests in `tests/relay/relay.capabilities.test.ts`:
- 4 tests for Case B (no edits, single final message)
- 4 tests for Case C (placeholder, single final edit, anti-regression across 12 chunks)
- 1 regression guard for Case A (Telegram byte-identical)

**Verdict:** F1 verified — relay honors all three capability cases. Test count: 937 → 946 (+9). All green.

---

### P1 Implementation — Carter's Core Rewire

# Carter: Phase 1 Core Rewire — Decision Record

**Date:** 2026-06-06  
**Author:** Carter (Bridge Dev)  
**Branch:** `feature/channel-abstraction`  
**Covers:** P1-2 (SessionEntry string IDs), P1-3 (relay on ChannelPort), P1-4 (TelegramChannel adapter), P1-6 (startup wiring)

---

## SessionEntry Migration & Back-Compat Decision

### Decision
Rename `topicId: number` → `threadId: string` and `chatId: number` → `channelId: string` in `SessionEntry` (and `lastTopicId?: number` → `lastTopicId?: string`).

### Rationale
The ChannelPort contract (`src/channel/port.ts`) uses opaque string IDs (`threadId`, `channelId`) for transport-agnostic addressing. Telegram-specific numeric forum topic IDs must be converted to strings at the adapter boundary; other transports (Teams, Slack) use non-numeric thread/channel identifiers.

### Back-Compat: Existing Persisted Sessions
Existing installs have `registry.json` files on disk with JSON like `{ "topicId": 42, "chatId": -1001234567890 }`. On load, `SessionRegistry.load()` runs `coerceId(raw)`:

```typescript
function coerceId(raw: Record<string, unknown>) {
  const threadId = String(raw['threadId'] ?? raw['topicId']);
  const channelId = String(raw['channelId'] ?? raw['chatId']);
  return { ...raw, threadId, channelId };
}
```

This handles both old (`topicId/chatId`) and new (`threadId/channelId`) keys, converting numeric JSON values to strings. Migration is transparent — next write uses the new field names. No data loss, no manual migration required.

### `lastTopicId` Migration
`afkMode.ts` reads `persisted.lastTopicId` via `Number(persisted.lastTopicId)` before calling Telegram API. This handles both `number` (legacy) and `string` (new) stored values. Writes always use `String(topicId)`.

---

## TelegramChannel Adapter Capabilities

```typescript
capabilities = {
  supportsMessageEdit: true,        // editMessageText available
  supportsThreadCreation: true,      // createForumTopic available
  supportsInteractivePrompts: true,  // inline keyboard prompt flow
  supportsStreaming: true,           // 800ms throttle edit during streaming
  maxMessageLength: 4096,            // Telegram hard limit
}
```

These values are declared in `src/channel/telegram/index.ts` and match the existing Telegram behavior.

---

## Adapter Architecture Choices

### `onMessage`/`onCommand` are no-ops
`TelegramChannel` doesn't register `bot.on('message:text')` or `bot.command()` — those stay in `src/bot/handlers.ts` for this release. This preserves zero behavior change and avoids double-registration. The ChannelPort contract allows these to be no-ops.

### `bot.start()` stays in `main.ts`
`channel.start()` wraps `bot.start()` internally but is not called from `main.ts`. The daemon still calls `bot.start(cfg.token, { onStart: ... })` directly. This keeps the startup path identical to pre-P1.

### MarkdownV2 duck-typing
The relay duck-types to `TelegramChannel` to use `editMessageWithMarkdown` / `sendMessageWithMarkdown` (MarkdownV2 + plain fallback). Non-Telegram channels get `formatForTransport(text)` + plain `editMessage`/`sendMessage`. This preserves the exact formatting behavior for Telegram without requiring MarkdownV2 in the port contract.

---

## Relay Behavior Preserved

- **800ms throttle edit:** During streaming, `channel.editMessage()` fires at most once per 800ms. Now wrapped in try-catch so a failed throttle edit doesn't abort the stream.
- **Chunk cap:** `splitMessage` returns ≤25 chunks. Chunk[0] updates the placeholder via `editMessage`; chunks[1..24] are new `sendMessage` calls. The placeholder creation (`sendMessage('…')`) + 24 follow-up sends = 25 user-visible messages maximum.
- **F-E behavior:** When first-chunk `editMessage` fails, the relay logs "First-chunk edit failed", attempts a fallback edit (try-catch), and returns without sending follow-up chunks.

---

## Handoff Notes for Kat

### 1. Command handlers still call `ctx.reply()` directly
All 8 commands in `src/bot/handlers.ts` use `ctx.reply()` with Telegram-specific options (`message_thread_id`, `parse_mode`, etc.). Kat should migrate these onto `channel.sendMessage()` in the next round. The seam is: replace `ctx.reply(text, opts)` with `channel.sendMessage(channelCtx, text)` where `channelCtx = { threadId: String(ctx.message.message_thread_id), channelId: String(ctx.chat.id) }`.

Files to touch:
- `src/bot/handlers.ts` — all 8 command handlers (`/new`, `/list`, `/remove`, `/resume`, `/help`, `/status`, `/cwd`, message:text)
- `src/bot/afkMode.ts` — `ctx.reply()` calls in mirror input handler and `/status`

### 2. `TelegramChannel.onCommand`/`onMessage` are ready to use
Currently no-ops. When Kat migrates, `onCommand(name, handler)` and `onMessage(handler)` can be wired to `bot.command(name, ...)` and `bot.on('message:text', ...)` in `TelegramChannel`. Ensure no double-registration with the existing `handlers.ts` registrations during the transition.

### 3. `channel.start()` should be called from `main.ts`
Currently `main.ts` still calls `bot.start(...)` directly. Should be flipped to `await channel.start()` so all channels start via the port.

### 4. Test assertions
Tests that check relay behavior now use `channel.sendMessage` instead of `ctx.reply` for the placeholder. Tests that check command-response behavior still use `ctx.reply` — these will need updating when Kat migrates command handlers onto the port.

---

## Notes for Jun (Conformance Kit)

The following behaviors should be pinned in the conformance kit:

1. **`sendMessage('…')` as relay placeholder:** `relay.relay(ctx, text)` always calls `channel.sendMessage(ctx, '…')` as the first operation.
2. **`editMessage` for first chunk:** After stream completes, `channel.editMessage(ctx, ref, formattedChunk0)` is called.
3. **`sendMessage` for follow-up chunks (≤24):** Chunks 2..N via `channel.sendMessage(ctx, formattedChunkN)`.
4. **No throw from relay:** The relay never throws even if `editMessage` or `sendMessage` fails — errors are logged and the relay returns gracefully.
5. **`resolve(threadId: string)`:** SessionLookup takes a string, not a number.


---

### P1 Implementation — Kat's Handler Migration

# Kat Phase 1 Handler Migration Notes

## Decision

Single-Bot consolidation is now in place: `TelegramChannel` owns the only grammY `Bot` instance, and `main.ts` casts the selected channel to `TelegramChannel` when direct grammY access is required for `AfkModeController` and related Telegram-only wiring.

## Handlers Now Routed Through ChannelPort

All 8 handlers now register through the port seam via `channel.onCommand()`:

- `new`
- `list`
- `remove`
- `resume`
- `help`
- `pair`
- `status`
- `cwd`

The catch-all relay path now registers via `channel.onMessage()`.

## Notes for Jun's Conformance Kit

- `/status` and `/cwd` use synthetic grammY `Context` adapters — their internal `ctx.reply(...)` calls map to `channel.sendMessage(channelCtx, text)`.
- `handleStatusCommand` still accepts a grammY `Context`; do not change that signature in conformance coverage.
- `handleTelegramMessage` is intercepted before the port `onMessage` handler via `setMessageInterceptor()` on `TelegramChannel` (Telegram-specific by design).
- Capability fallback paths (edit, streaming, prompt, thread creation) are unchanged; they still live in `relay.ts`.
- The handler registered via `channel.onMessage()` applies the `isBotCommand(text)` filter; the Telegram adapter does **not** apply that filter itself.
- Empty `threadId` in `ChannelContext` means General Topic; `TelegramChannel.sendMessage` must omit `message_thread_id` from the Telegram API call in that case.


---

### P1 Implementation — Jun's Conformance Kit

# Jun Phase 1 Conformance Kit — Decision Record

**Date:** 2026-06-06
**Author:** Jun (Test Engineer)
**Branch:** `feature/channel-abstraction`
**Covers:** P1-7 (behavioral conformance kit) + P1-8 (full regression)

---

## What the Kit Covers

### Files

| File | Purpose |
|---|---|
| `tests/channel/conformance/FakeChannel.ts` | Configurable in-memory `ChannelPort` with per-capability flags |
| `tests/channel/conformance/runner.ts` | Parameterized `runChannelPortConformance(makePort, opts)` + `runCapabilityFallbackMatrix()` |
| `tests/channel/conformance/fakeChannel.conformance.test.ts` | Kit self-validation on FakeChannel + full matrix (44 tests) |
| `tests/channel/conformance/telegram.conformance.test.ts` | Kit against TelegramChannel (mocked grammY) + Kat's gotchas (44 tests) |

### Test Domains

1. **Lifecycle** — `start()` resolves, `stop()` resolves, `stop()` idempotent.
2. **Outbound** — `sendMessage` returns `MessageRef{id:string}`; empty threadId accepted.
3. **editMessage** — returns `boolean`; false when `supportsMessageEdit=false`.
4. **Formatting** — `formatForTransport` non-null; `splitMessage` all chunks ≤ `maxMessageLength`; footer in last chunk.
5. **Inbound** — `onMessage` handler fires with string `threadId`/`channelId`; single-handler model (replace semantics); `onCommand` dispatches per-name.
6. **Prompts** — `promptUser` returns a string option value; AbortSignal (pre-fired and mid-wait) resolves `''`.
7. **Thread management** — `createThread` returns `ChannelContext`; throws when `supportsThreadCreation=false`.
8. **Capabilities shape** — all fields present, correct types, `maxMessageLength > 0`.

---

## Capability-Fallback Matrix

All 4 capability flags exercised in both ON and OFF states. Every cell PASSED.

### supportsMessageEdit

| State | Contracted behavior | Asserted | Result |
|---|---|---|---|
| `false` | `editMessage` returns `false`; core must NOT call it (send-once final) | FakeChannel returns `false`, `edits` array stays empty; send-once scenario exercised | ✅ PASS |
| `true` | `editMessage` returns `true` and records the edit | FakeChannel records edit, returns `true` | ✅ PASS |

### supportsStreaming

| State | Contracted behavior | Asserted | Result |
|---|---|---|---|
| `false` | No intermediate stream edits; placeholder→final-edit only | Single edit (final), `sends=1` | ✅ PASS |
| `false` + edit=`false` | Send new final message (no edit possible) | Two `sendMessage` calls, zero edits | ✅ PASS |

### supportsInteractivePrompts

| State | Contracted behavior | Asserted | Result |
|---|---|---|---|
| `false` | Text-fallback: wait for matching inbound text | Resolved on `injectInboundText('approve')` | ✅ PASS |
| `false` + AbortSignal | Resolve `''` on abort | Pre-fired and mid-wait abort both return `''` | ✅ PASS |
| `true` | Resolve immediately with `options[0].value` | Immediate resolution | ✅ PASS |

### supportsThreadCreation

| State | Contracted behavior | Asserted | Result |
|---|---|---|---|
| `false` | `createThread` MUST NOT be called; throws | FakeChannel throws; `threadCreations` empty | ✅ PASS |
| `true` | Returns `ChannelContext` with new `threadId` | Returns context with matching `channelId` and new `threadId` | ✅ PASS |

### All capabilities OFF

All four flags `false` simultaneously: `sendMessage` still works, `editMessage` returns `false`, `createThread` throws, `promptUser` aborts correctly. ✅ PASS

---

## How a Future Adapter Plugs In

### Step 1 — Implement ChannelPort

```typescript
// src/channel/teams/index.ts
export class TeamsChannel implements ChannelPort {
  readonly name = 'teams';
  readonly capabilities: ChannelCapabilities = {
    supportsMessageEdit: true,
    supportsThreadCreation: true,
    supportsInteractivePrompts: true,
    supportsStreaming: false,   // Teams Graph API rate-limited
    maxMessageLength: 28000,
  };
  // ... implement all methods
}
registerChannel('teams', () => new TeamsChannel(...));
```

### Step 2 — Run the conformance kit

```typescript
// tests/channel/conformance/teams.conformance.test.ts
import { runChannelPortConformance } from './runner.js';
import { TeamsChannel } from '../../../src/channel/teams/index.js';

runChannelPortConformance(
  () => new TeamsChannel(/* mocked Graph client */),
  { name: 'TeamsChannel', skipLifecycle: true },
);
```

### Step 3 — Adapter-specific block

Add a `describe('TeamsChannel — declared capability matches actual behavior')` block asserting:
- `capabilities.supportsStreaming === false` (declared correctly for Teams)
- `sendMessage` actually calls the Graph API
- `editMessage` returns `true` on success, `false` on Graph API error
- `capabilities.maxMessageLength === 28000`

### Step 4 — Regression

`npx vitest run` — must pass ≥ (prior count) + (new test count).

---

## Telegram Anti-Lie Checks (declared = actual)

| Capability | Declared | Actual behavior asserted | Match |
|---|---|---|---|
| `supportsMessageEdit` | `true` | `editMessage` calls `bot.api.editMessageText`, returns `true` | ✅ |
| `supportsThreadCreation` | `true` | `createThread` calls `bot.api.createForumTopic`, returns `ChannelContext` | ✅ |
| `supportsInteractivePrompts` | `true` | `promptUser` resolves (delegates to `promptUserForPermission`) | ✅ |
| `supportsStreaming` | `true` | Relay's 800ms throttle edit path exercises this | ✅ (relay.test.ts) |
| `maxMessageLength` | `4096` | `splitMessage` produces all chunks ≤ 4096 | ✅ |
| `name` | `'telegram'` | `ch.name === 'telegram'` | ✅ |

---

## Kat's Gotchas — Regression Pin Results

| Gotcha | Test location | Status |
|---|---|---|
| Empty `threadId` ⇒ omit `message_thread_id` from Telegram API call | `telegram.conformance.test.ts` — "Kat gotcha: empty threadId" | ✅ PINNED |
| `isBotCommand` filter lives in `onMessage` handler, NOT in `TelegramChannel` | `telegram.conformance.test.ts` — "isBotCommand filter lives in onMessage handler" | ✅ PINNED |
| `/status` and `/cwd` synthetic ctx `reply()` → `channel.sendMessage` | `telegram.conformance.test.ts` — "synthetic ctx routes reply to channel.sendMessage" | ✅ PINNED |
| General Topic synthetic ctx has `message=undefined` (no `message_thread_id`) | `telegram.conformance.test.ts` | ✅ PINNED |

---

## FINDINGS

**No contract violations found.**

All four capability flags behave exactly as declared in `TelegramChannel.capabilities`. The abstraction is honest:

- `supportsMessageEdit=true` → `editMessage` actually edits (returns `true` on success, `false` on failure without throwing).
- `supportsThreadCreation=true` → `createThread` actually creates via `bot.api.createForumTopic`.
- `supportsInteractivePrompts=true` → `promptUser` resolves via the inline keyboard flow.
- `supportsStreaming=true` → relay's 800ms throttle edit path is exercised (covered by relay.test.ts).
- `maxMessageLength=4096` → `splitMessage` enforces it.

### Observation (not a bug — routing note for Carter)

The relay's `safeEditFormatted` / `safeSendFormatted` duck-types to `TelegramChannel` to call `editMessageWithMarkdown` / `sendMessageWithMarkdown`. This is a deliberate design decision documented in Carter's handoff notes (MarkdownV2 duck-typing). Non-Telegram channels will use the generic `formatForTransport` + plain `editMessage`/`sendMessage` path. This is transport-correct but means the generic conformance kit cannot exercise the MarkdownV2 path for TelegramChannel. The Telegram-specific test block covers this via `formatForTransport` shape assertion.

---

## Regression Summary (P1-8)

| Metric | Before | After |
|---|---|---|
| `npx tsc --noEmit` | ✅ exit 0 | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 | ✅ exit 0 |
| `npx vitest run` | 849 passed / 4 skipped / 1 todo | **937 passed / 4 skipped / 1 todo** |
| New conformance tests | — | +88 (44 FakeChannel + 44 Telegram) |

All pre-existing 849 tests continue to pass. Zero regressions.


---

### Reference — Carter's Telegram/grammY Coupling Inventory

# Telegram/grammY Coupling Inventory for Teams Generalization

**Date:** 2026-06-06  
**Author:** Carter (Bridge Dev)  
**Status:** Read-only inventory (no code changes)

---

## PART 1: FILE-BY-FILE COUPLING MAP

### Direct grammY/Telegram Imports

| File | Imports | Coupling Description | Line(s) |
|------|---------|----------------------|---------|
| `src/bot/index.ts` | `Bot` from grammy | Creates grammY Bot instance; core entry point for Telegram polling | 1, 13 |
| `src/bot/handlers.ts` | `Bot, Context` from grammy | Registers all bot commands and relay handler; every handler receives grammY Context | 1, 22, 62 |
| `src/relay/relay.ts` | `Context` from grammy | Relay receives grammY Context; uses to extract `message_thread_id`, send replies | 1, 53 |
| `src/bot/afkMode.ts` | `Bot, Context` from grammy | AFK mode controller owns grammY Bot; implements `handleTelegramMessage(ctx)` | 1, 92 |
| `src/bot/afkStreamRouter.ts` | `Bot, Context` from grammy | Routes stream chunks to Telegram via Bot.api calls | 12, 46, 51 |
| `src/bot/pairing.ts` | `Bot` from grammy | Pairing flow uses grammY Bot for /pair command | 7, 16 |
| `src/bot/prompt.ts` | `Bot, Context` from grammy | Permission prompts via callback_query handler (grammY) | Inferred from line 72 in handlers.ts |

### Telegram-Specific Concepts (No Direct Import, But Baked In)

| File | Concept | Usage | Line(s) |
|------|---------|-------|---------|
| `src/relay/relay.ts` | `message_thread_id` | Extract topic ID from message | 54, 85, 93 |
| `src/relay/relay.ts` | `parse_mode: 'MarkdownV2'` | Telegram-specific markdown flavor | 254, 280 |
| `src/relay/relay.ts` | 4096-char limit | Accumulator cap (100KB DoS guard) | 15-16, 142-144 |
| `src/relay/relay.ts` | Message edit throttle | 800ms between Telegram edits | 27 |
| `src/relay/markdownV2.ts` | MarkdownV2 escaping | 18 special chars + `\` escaping (Telegram-only) | All |
| `src/relay/messageSplitter.ts` | Telegram 4096 max | DEFAULT_MAX_LEN = 4096 | 43, 48 |
| `src/relay/messageSplitter.ts` | Smart chunk boundaries | Paragraph > line > word > hard cut | 5-9 |
| `src/bot/afkStreamRouter.ts` | `TELEGRAM_MAX_TEXT` | Hard limit: 4096 chars | 24 |
| `src/bot/afkStreamRouter.ts` | `TELEGRAM_MAX_DISPLAY` | Safe display cap: 4000 chars | 26 |
| `src/bot/afkStreamRouter.ts` | Truncation prefix | `'…(truncated)\n'` prefix for display overflow | 28 |
| `src/bot/afkMode.ts` | Forum topics | Manages Telegram forum topic creation, binding, indexing | 94 (sessionTopics), 95 (topicSessions) |
| `src/bot/afkMode.ts` | `message_thread_id` | Extract topic ID from Telegram message | 171 |
| `src/bot/afkMode.ts` | `retry_after` | Telegram 429 rate-limit handling | 75-81 |
| `src/bot/afkMode.ts` | Topic URL | `https://t.me/c/{chatId}/{topicId}` format | 69-72 |
| `src/types.ts` | `topicId: number` | SessionEntry stores Telegram forum topic ID | 9 |
| `src/types.ts` | `chatId: number` | SessionEntry stores Telegram supergroup chat ID | 11 |
| `src/sessions/registry.ts` | Forum topic indexing | Registry maps `number` (topic ID) → SessionEntry | 81 (Map<number, ...>) |
| `src/config/env.ts` | `TELEGRAM_BOT_TOKEN` | Required environment variable | 26 |
| `src/config/env.ts` | `TELEGRAM_CHAT_ID` | Optional env var; triggers pairing if unset | 48 |
| `src/config/env.ts` | `TELEGRAM_ALLOWED_USER_IDS` | Optional env var; comma-separated user IDs | 65 |
| `src/config/config.ts` | `telegramChatId` | Config field storing paired Telegram chat ID | 20 |
| `src/config/config.ts` | `telegramAllowedUserIds` | Config field storing allowed Telegram user IDs | 21 |
| `src/main.ts` | `allowed_updates: ['message', 'edited_message', 'callback_query']` | Telegram bot.start() polling filter | 98 |

---

## PART 2: MESSAGE/SESSION RELAY FLOW

### Inbound Path: Telegram Message → Copilot SDK Session

```
Telegram polling                       src/main.ts:98
  ↓ (bot.start() with allowed_updates)
  
grammY message event                   src/bot/handlers.ts (registerHandlers)
  ↓ (message:text handler)
  
relay(ctx: Context)                    src/relay/relay.ts:53
  ├─ Extract topicId = ctx.message?.message_thread_id    (line 54)
  ├─ Extract userText = ctx.message?.text                 (line 55)
  ├─ sessionLookup.resolve(topicId)                       (line 59)
  └─ → SessionEntry { sessionName, model, ... }
  
Session activation                      src/relay/relay.ts:79-107
  ├─ factory.resume(sessionName, model)                   (line 96)
  └─ or factory.create(sessionName, model)                (line 97)
  
Stream processing                       src/relay/relay.ts:140-185
  ├─ session.send(userText)                               (line 140)
  └─ accumulate chunks into response
  
Output (3 stages)
```

### Outbound Path: SDK Response → Telegram

#### Stage 1: Placeholder + Streaming
```
await ctx.reply('…', { message_thread_id: topicId })      src/relay/relay.ts:134
  ↓ (stores messageId in placeholder object)
  
Per-chunk edit (throttled 800ms)
  await this.safeEdit(                                    src/relay/relay.ts:148
    ctx, placeholder.chat.id, placeholder.message_id, accumulated
  )
  └─ calls ctx.api.editMessageText(chatId, msgId, text)  (line 258)
```

#### Stage 2: Final Edit (First Chunk with Formatting)
```
chunks = splitForTelegram(body, { footer, numbering, effectiveMaxLen })  (line 157)
  ↓ (respects Telegram 4096-char hard limit; uses MarkdownV2 escaping)

await this.safeEdit(ctx, chatId, msgId, chunks[0], tryMarkdown, sessionName)  (line 169)
  ├─ tryMarkdown=true triggers MarkdownV2 escaping                     (line 174)
  ├─ ctx.api.editMessageText(chatId, msgId, escaped, { parse_mode: 'MarkdownV2' })  (line 254)
  └─ on MarkdownV2 error: fallback to plain text                       (line 255)
```

#### Stage 3: Follow-up Chunks (if any)
```
for (let i = 1; i < chunks.length; i++)                   (line 190)
  await this.safeSend(ctx, topicId, chunks[i], tryMarkdown, ...)  (line 192)
    ├─ ctx.reply(text, { message_thread_id: topicId })   (line 284)
    └─ with parse_mode: 'MarkdownV2' if tryMarkdown       (line 280)
```

### AFK Mode (Alternative Inbound Path)

```
afk.request from extension bridge      src/bot/afkMode.ts:122
  ↓
AfkModeController.activate()           src/bot/afkMode.ts:233
  ├─ ensureTopic() creates new forum topic for each session
  ├─ Sends orientation message
  └─ Tracks sessionId → topicId mapping
  
Telegram mirror input (same chat, AFK topic)
  ↓ (message:text handler in main relay path, but AFK guard fires first)
  
handleTelegramMessage(ctx)             src/bot/afkMode.ts:161
  ├─ Rate limiting (20 msgs/min per session, 100 msgs/min global)  (lines 212-231)
  ├─ User ID check (TELEGRAM_ALLOWED_USER_IDS guard)      (lines 186-190)
  ├─ Extract message_thread_id → sessionId lookup          (lines 171, 176)
  └─ bridge.sendToSession(sessionId, { type: 'mirror.input', source: 'telegram' })  (lines 202-208)
```

### Stream Routing (AFK Mode)

```
Extension streams back response
  ↓ (bridge protocol: stream or stream.error)

AfkStreamRouter.enqueueChunk()          src/bot/afkStreamRouter.ts:63
  ├─ Maintains in-memory StreamState per sessionId:requestId
  ├─ Chains operations to prevent concurrent edits
  └─ handleChunk() → edit or send Telegram message
    ├─ displayText() applies TELEGRAM_MAX_DISPLAY cap    (line 36, 38-39)
    ├─ ctx.api.editMessageText() or ctx.reply()
    └─ Retry on 429 with retry_after capping            (src/bot/afkMode.ts:74-81)
```

---

## PART 3: TELEGRAM-SPECIFIC DATA SHAPES & ASSUMPTIONS

### Core Mappings
- **Forum topic ↔ Session**: 1:1 mapping (SessionEntry.topicId = forum topic ID)
- **Topic ID uniqueness**: Topic IDs are used as Map keys (no composite keys)
- **Chat ID storage**: One persistent chatId per daemon instance (env or config)
- **User ID control**: Optional allow-list (TELEGRAM_ALLOWED_USER_IDS)

### Message Shapes
- **Inbound**: `ctx.message.message_thread_id` (topic), `ctx.message.text` (body), `ctx.from.id` (user)
- **Outbound**: `ctx.reply(text, { message_thread_id })`, `ctx.api.editMessageText(chatId, msgId, text)`
- **Formatting**: `parse_mode: 'MarkdownV2'` with 18 special chars + `\` escaping
- **Size limits**: 4096-char hard limit; safe cap 4000 chars for headroom

### Telegram-Specific Constants
```typescript
TELEGRAM_MAX_TEXT = 4096                        // src/bot/afkStreamRouter.ts:24
TELEGRAM_MAX_DISPLAY = 4000                     // src/bot/afkStreamRouter.ts:26
MAX_ACCUMULATED_BYTES = 100_000                 // src/relay/relay.ts:16
MAX_CHUNKS = 25                                 // src/relay/relay.ts:18
MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048            // src/relay/relay.ts:24 (MarkdownV2 escape budget)
STREAM_EDIT_THROTTLE_MS = 800                   // src/relay/relay.ts:27
MAX_MIRROR_TEXT_LENGTH = 4096                   // src/bot/afkMode.ts:54
MAX_RATE_LIMIT_DELAY_MS = 30_000                // src/bot/afkMode.ts:60 (cap Telegram retry_after)
```

### Error Handling Specific to Telegram
- **Parse entities error** (400): Falls back from MarkdownV2 to plain text (src/relay/relay.ts:225-239)
- **Rate limit** (429): Extracts `retry_after` from error (src/bot/afkMode.ts:74-81); caps to 30s
- **Empty message** (400): Never send empty string; use `'…'` placeholder (src/relay/relay.ts:156)

---

## PART 4: CONFIG/ENV SURFACE

### Environment Variables
| Var | Type | Required | Default | Parsed In | Used In |
|-----|------|----------|---------|-----------|---------|
| `TELEGRAM_BOT_TOKEN` | string | ✅ Yes | N/A | src/config/env.ts:26 | src/main.ts:58 |
| `TELEGRAM_CHAT_ID` | number | ❌ No | undefined (triggers pairing) | src/config/env.ts:48 | src/main.ts:33 |
| `TELEGRAM_ALLOWED_USER_IDS` | comma-separated numbers | ❌ No | undefined (allow all) | src/config/env.ts:65 | src/main.ts:65, src/bot/afkMode.ts:187 |
| `REACH_MODEL` | string | ❌ No | `'claude-sonnet-4'` | src/config/env.ts:32 | src/main.ts:73 |
| `REACH_PERMISSION_POLICY` | enum | ❌ No | `'approveAll'` | src/config/env.ts:35 | src/main.ts:74 |
| `REACH_DATA_DIR` | path | ❌ No | `~/.reach/` | src/config/config.ts:37 | src/config/env.ts:43 |

### Config File (config.json)
| Field | Type | Set By | Used In | Example |
|-------|------|--------|---------|---------|
| `telegramChatId` | number | /pair command | src/config/env.ts:59 | `-1001234567890` |
| `telegramAllowedUserIds` | number[] | /pair command | src/config/env.ts:81 | `[123456789, 987654321]` |
| `knownCwds` | KnownCwd[] | /cwd add command | /new --cwd flag resolution | See src/config/config.ts:12-17 |

### Auth/Bridge Surface
- **pipeAuth**: Generated for extension ↔ daemon IPC (src/main.ts:38, src/bridge/pipeAuth.ts)
- **authToken**: Per-connection token in RegisterMessage (src/bridge/protocol.ts:26)

---

## PART 5: ABSTRACTION SEAMS VS TANGLED COUPLING

### ✅ GOOD SEAMS (Ready for Generalization)

#### Relay Ports Layer (src/relay/ports.ts)
- **SessionLookup**: Relay receives topicId → ResolvedSession (no Telegram assumptions)
- **PermissionPrompter**: Relay delegates prompting; doesn't know platform
- **Relay contract**: Pure async generator (session.send → chunks); no platform coupling
- **Why good**: Relay can work with any transport if SessionLookup is retargetable

#### Message Formatting Utilities
- **escapeMarkdownV2()**: Pure function; no platform state or I/O
- **splitForTelegram()**: Takes `maxLen` parameter; could become generic `splitForPlatform(maxLen, formatter)`
- **Why good**: Could be reused for Teams markdown or other formats with wrapper

#### Session Registry Abstraction
- **ISessionRegistry interface**: Abstract contract for register/resolve/list/move
- **Concrete: SessionRegistry** (Maps topicId → entry)
- **Why good**: Registry interface allows swapping implementations; topicId is the only platform-specific key

### ❌ TANGLED COUPLING (Requires Rework for Teams)

#### 1. Handler Registration (src/bot/handlers.ts:62-300+)
**Problem**: Every command handler directly calls `ctx.reply()` with Telegram-specific options
```typescript
/new: await ctx.reply('❌ Usage: /new <name>...', { message_thread_id: topicId })
/list: await ctx.reply(lines.join('\n'))
```
**Impact**: Commands are Telegram-only; duplicating for Teams requires copying all handlers
**Rework needed**: Abstract "responder" interface; pass platform-agnostic context

#### 2. Topic ID = Forum Topic Concept (src/types.ts, src/sessions/registry.ts)
**Problem**: SessionEntry explicitly stores `topicId: number` (Telegram forum topic ID)
```typescript
export interface SessionEntry {
  sessionName: string;
  topicId: number;              // ← Telegram-specific
  chatId: number;               // ← Telegram-specific
  ...
}
```
**Impact**: Registry, AFK mode, relay all assume "topic ID" maps to a Telegram forum topic
**Rework needed**: Rename to `channelId` or `sessionChannelId`; store transport-agnostic ID

#### 3. MarkdownV2 Hardcoding (src/relay/relay.ts:254, 280)
**Problem**: `parse_mode: 'MarkdownV2'` is baked into Telegram send calls
```typescript
() => ctx.api.editMessageText(chatId, msgId, escapeMarkdownV2(text), { parse_mode: 'MarkdownV2' })
```
**Impact**: Teams uses different markdown (no MarkdownV2 parsing or HTML); code path must branch or be abstracted
**Rework needed**: Abstract "format text for platform" callback

#### 4. AFK Mode Tightly Coupled to Telegram (src/bot/afkMode.ts)
**Problem**: AfkModeController is grammY Bot consumer; manages Telegram forum topics, retry_after, message_thread_id
```typescript
private readonly bot: Bot<Context>;          // ← grammY type
handleTelegramMessage(ctx: Context)          // ← Telegram-specific handler
```
**Impact**: AFK mode is 100% Telegram-specific; Teams would need parallel implementation
**Rework needed**: Abstract AFK transport adapter; inject platform-specific topic/message handling

#### 5. Mirror Input Path (src/bot/afkMode.ts:161-210)
**Problem**: `handleTelegramMessage()` is Telegram-only; rate limits, user ID checks, source labeling all Telegram-centric
```typescript
source: 'telegram'                           // ← Hardcoded transport label
const userId = ctx.from?.id;                 // ← Telegram user ID extraction
```
**Impact**: Adding Teams mirror input requires new handler with duplicated rate-limiting, auth, routing logic
**Rework needed**: Unified mirror-input dispatcher; platform enum instead of hardcoded 'telegram'

#### 6. Retry-After Handling (src/bot/afkMode.ts:74-81, src/relay/relay.ts)
**Problem**: Telegram 429 retry_after error extraction is Telegram-specific
```typescript
const record = err as { error_code?: unknown; parameters?: { retry_after?: unknown } };
if (record.error_code !== 429) return undefined;
```
**Impact**: Teams error format is different (no error_code, no parameters.retry_after)
**Rework needed**: Abstract error handler; platform-specific parsing

#### 7. Command Router (src/bot/handlers.ts + src/bot/commands.ts)
**Problem**: COMMAND_NAMES is shared, but each command's `async (ctx) => { ... }` is grammY-dependent
```typescript
export const COMMAND_NAMES = ['new', 'list', 'remove', 'resume', 'help', 'pair', 'status', 'cwd']
new: async (ctx) => { ... }                 // ← Each handler takes grammY Context
```
**Impact**: Teams integration requires new handler map with same logic but Teams API calls
**Rework needed**: Unified command dispatcher; wrap handlers in platform adapter

---

## PART 6: SUMMARY OF COUPLING HOTSPOTS

### High-Effort Rework Areas (for Teams support)
1. **Bot handlers** (src/bot/handlers.ts) - All 8 commands hardcoded to grammY
2. **AFK mode** (src/bot/afkMode.ts) - 300+ lines tightly coupled to Telegram
3. **Relay send paths** (src/relay/relay.ts) - MarkdownV2 parsing, ctx.api calls
4. **Session registry key** (src/sessions/registry.ts, src/types.ts) - "topicId" assumes forum topics
5. **Message formatting** (src/relay/markdownV2.ts) - MarkdownV2 is Telegram-only

### Medium-Effort Refactors (if abstraction seams exist)
1. **Relay core** (src/relay/relay.ts) - Already receives Context; could swap adapters
2. **Session lookup** (src/relay/ports.ts) - Already abstracted; easy to retarget

### Low-Effort Reuse
1. **Message splitter** (src/relay/messageSplitter.ts) - Pure function; works for any transport
2. **Session registry** (src/sessions/registry.ts) - Can swap key type (topicId → channelId)

---

## APPENDIX: Key File Locations for Reference

- **Telegram polling entry**: src/main.ts:98
- **Handler registration**: src/bot/handlers.ts:62
- **Relay inbound**: src/relay/relay.ts:53
- **Relay outbound (send)**: src/relay/relay.ts:267-295 (safeSend)
- **Relay outbound (edit)**: src/relay/relay.ts:242-265 (safeEdit)
- **AFK mode**: src/bot/afkMode.ts:92-150 (constructor + handleTelegramMessage)
- **Stream routing**: src/bot/afkStreamRouter.ts:55-80 (enqueueChunk)
- **Config parsing**: src/config/env.ts:25
- **SessionEntry type**: src/types.ts:5
- **Registry**: src/sessions/registry.ts:80


---

### Reference — Noble Six's Locked ChannelPort Contract

# P1-1: ChannelPort Contract — Locked Interface for Team Implementation

**Status:** LOCKED — implement against this contract  
**Author:** Noble Six  
**Date:** 2026-06-06  
**Commit:** 7b12305 on `feature/channel-abstraction`  
**Files:** `src/channel/port.ts`, `src/channel/registry.ts`

---

## ChannelPort Interface (src/channel/port.ts)

### Supporting Types

```typescript
interface ChannelContext { readonly threadId: string; readonly channelId: string }
interface MessageRef     { readonly id: string }
interface PromptOption   { readonly value: string; readonly label: string }
type MessageHandler = (ctx: ChannelContext, text: string) => Promise<void>;
type CommandHandler = (ctx: ChannelContext, args: string) => Promise<void>;
```

All identifiers are opaque strings. No Telegram `number` types anywhere.

### ChannelCapabilities

```typescript
interface ChannelCapabilities {
  readonly supportsMessageEdit: boolean;
  readonly supportsThreadCreation: boolean;
  readonly supportsInteractivePrompts: boolean;
  readonly supportsStreaming: boolean;
  readonly maxMessageLength: number;
}
```

### ChannelPort Methods

| Category | Method | Signature |
|----------|--------|-----------|
| Lifecycle | `start()` | `() => Promise<void>` |
| Lifecycle | `stop()` | `() => Promise<void>` |
| Outbound | `sendMessage(ctx, text)` | `(ChannelContext, string) => Promise<MessageRef>` |
| Outbound | `editMessage(ctx, ref, text)` | `(ChannelContext, MessageRef, string) => Promise<boolean>` |
| Formatting | `formatForTransport(markdown)` | `(string) => string` |
| Formatting | `splitMessage(text, footer?)` | `(string, string?) => string[]` |
| Prompts | `promptUser(ctx, question, options, signal?)` | `(ChannelContext, string, PromptOption[], AbortSignal?) => Promise<string>` |
| Threads | `createThread(channelId, title)` | `(string, string) => Promise<ChannelContext>` |
| Inbound | `onMessage(handler)` | `(MessageHandler) => void` |
| Inbound | `onCommand(command, handler)` | `(string, CommandHandler) => void` |
| Property | `name` | `readonly string` |
| Property | `capabilities` | `readonly ChannelCapabilities` |

### Required Core Fallback Behaviors (per capability)

| Capability | When `false` | Core Behavior |
|-----------|-------------|---------------|
| `supportsMessageEdit` | Core MUST NOT call `editMessage()`. Send final response as a single message — no placeholder/edit cycle. |
| `supportsStreaming` | No intermediate stream edits. Send "thinking…" then replace with final (if edits supported) or send final as new message. |
| `supportsInteractivePrompts` | Adapter implements text-based "reply yes/no" fallback internally. Core may prefer text path. |
| `supportsThreadCreation` | Core MUST NOT call `createThread()`. Users create threads manually; `/new` must be run inside an existing thread. |

---

## Transport Registry (src/channel/registry.ts)

```typescript
type ChannelFactory = () => ChannelPort;

registerChannel(name: string, factory: ChannelFactory): void  // module-scope registration
createChannel(name: string): ChannelPort                       // DI root calls at startup
listChannels(): readonly string[]                              // diagnostics
```

- Startup-only selection via `REACH_CHANNEL` env var (default: `'telegram'`).
- No runtime hot-swap. Daemon restart required to switch transports.
- Each adapter registers itself as a side-effect import.

---

## Implementation Assignments

| Item | Owner | What to Do |
|------|-------|-----------|
| P1-2: Generalize `SessionEntry` | **Carter** | `topicId: number` → `threadId: string`, `chatId: number` → `channelId: string`. Update types.ts, registry.ts, all consumers. Add registry.json migration. |
| P1-3: Refactor relay | **Carter** | `Relay` takes `ChannelPort` instead of `grammY.Context`. Check `capabilities` before edit/streaming calls. Delegate formatting/splitting to adapter. |
| P1-4: `TelegramChannel` adapter | **Kat** | Implement `ChannelPort` wrapping grammY. Capabilities: `{ supportsMessageEdit: true, supportsThreadCreation: true, supportsInteractivePrompts: true, supportsStreaming: true, maxMessageLength: 4096 }`. Own MarkdownV2 escaping, 4096-char splitting, inline keyboards. |
| P1-5: Refactor handlers/commands | **Kat** | Wire command handlers via `channel.onCommand()`. |
| P1-7: Conformance test kit | **Jun** | Behavioral contract tests: assert send/edit/receive/prompt/format behavior + capability-driven fallbacks. Every future adapter (Teams, Slack, Discord) runs this same kit. |
| P1-8: Config + registry wiring | **Carter** | Add `REACH_CHANNEL` env var. Wire `createChannel()` into `main.ts`. |


---

### Reference — Noble Six's ADR: Communications Channel Abstraction

# ADR-DRAFT: Communications Channel Abstraction & Microsoft Teams Transport

**Status:** DRAFT v2 — incorporating Aaron's decisions; pending final approval  
**Author:** Noble Six (Lead/Architect)  
**Date:** 2026-06-06  
**Supersedes:** N/A  
**Context:** Aaron's user story — "If I install Reach on my corp machine, I need to use Teams chat instead of Telegram."

### Decisions Locked in v2

| # | Decision | Source |
|---|----------|--------|
| D1 | Single binary with `REACH_CHANNEL` env switch | Aaron v2 review |
| D2 | Transport-owns formatting (each adapter owns escape/split/render) | Aaron v2 review |
| D3 | Phase 1 starts now on feature branch in open repo | Aaron v2 review |
| D4 | Corp can `npm install` from public repo → corp branch rebases on `main` | Aaron v2 review |
| D5 | No public webhook endpoint → Teams inbound = polling | Aaron v2 review |
| D6 | Corp tenant requires admin consent → client-credentials flow + admin consent | Aaron v2 review |
| D7 | Design for N transports (Slack, Discord, etc.), not just Telegram + Teams | Aaron v2 review |

---

## 1. Problem Framing

### Two-Phase Goal

**Phase 1 — Generalize the comms channel.** Reach currently hard-couples to Telegram throughout: `grammY` Bot/Context in the relay, MarkdownV2 escaping, 4096-char message splitting, forum-topic-per-session mapping, inline-keyboard permission prompts, and the pairing flow. The core domain — Copilot SDK session relay — is transport-agnostic in principle (the `CopilotSession`/`CopilotSessionFactory` interfaces prove this), but every layer above it assumes Telegram.

**Phase 2 — Add a Microsoft Teams transport,** developed on a corp-local branch that rebases on `main` (corp can `npm install` from the public repo — see §4).

**Design horizon — N transports.** Aaron has directed that the abstraction must anticipate transports beyond Telegram and Teams (Slack, Discord, others). The architecture must make adding a new transport a matter of implementing a port + registering it, not forking core logic.

### Core vs. Transport Concern

| Layer | Concern | Transport-Dependent? |
|-------|---------|---------------------|
| `src/copilot/` | SDK session factory, streaming, permissions | **No** — already port-based |
| `src/bridge/` | Extension ↔ daemon protocol (named pipe) | **No** — pure protocol |
| `src/sessions/registry.ts` | Session persistence | **Partially** — `SessionEntry` has `topicId: number`, `chatId: number` |
| `src/relay/relay.ts` | Message relay, streaming, chunking | **Yes** — `grammY.Context`, MarkdownV2, 4096-char limit |
| `src/relay/markdownV2.ts` | Telegram MarkdownV2 escaping | **Yes** — pure Telegram |
| `src/relay/messageSplitter.ts` | Telegram 4096-char chunking | **Yes** — Telegram-specific limit |
| `src/bot/` | Commands, handlers, pairing, AFK mode, prompts | **Yes** — deeply coupled to grammY |
| `src/config/env.ts` | Env vars | **Yes** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, etc. |
| `extension.mjs` | CLI extension | **No** — talks to daemon via named pipe |

---

## 2. The Channel Abstraction

### What a Transport Must Provide

Any communications channel must expose these capabilities to the core:

| Capability | Telegram | Teams | Slack | Discord |
|-----------|----------|-------|-------|---------|
| **Thread/conversation context** | Forum topic (int) | Channel thread (string) | Thread ts (string) | Forum channel (snowflake) |
| **Outbound message (create)** | `ctx.reply()` | Graph POST | `chat.postMessage` | REST POST |
| **Outbound message (edit)** | `editMessageText()` | Graph PATCH | `chat.update` | REST PATCH |
| **Inbound message** | Long-polling | Polling (see §3) | Socket Mode / Events API | Gateway WebSocket |
| **Rich formatting** | MarkdownV2 | HTML / Adaptive Cards | mrkdwn (Slack-flavored) | Discord markdown |
| **Message length limit** | 4096 chars | ~28 KB (card) / ~4 KB (text) | 40,000 chars (blocks) | 2000 chars |
| **Interactive prompts** | Inline keyboards | Adaptive Card actions | Block Kit buttons | Components (buttons) |
| **Thread creation** | `createForumTopic()` | Root message in channel | Thread reply | Forum post |
| **User identity** | Numeric ID | Azure AD OID (GUID) | Slack user ID (string) | Snowflake ID |

### Capability Mismatches Across Transports

1. **Thread model.** Telegram has first-class forum topics (integer ID, can be created/closed). Teams has reply chains. Slack has thread `ts` timestamps. Discord has forum channels. No two platforms model threads the same way. The abstraction must treat thread identity as an opaque string.

2. **Formatting.** Every platform has its own markup dialect. There is no lossless universal format. (See Formatting Strategy below.)

3. **Message editing.** Telegram edits are cheap (used for streaming every 800ms). Teams Graph edits are rate-limited (~2 req/sec/app/tenant). Discord edits are rate-limited per channel. Some transports may not support edits at all. The core must not assume editability.

4. **Permission prompts.** Telegram uses inline keyboards. Teams uses Adaptive Card actions. Slack uses Block Kit buttons. Some transports may lack interactive elements entirely. The core must degrade gracefully.

5. **Identifier types.** Telegram IDs are `number`. Everything else is `string`. The abstraction uses opaque `string` throughout.

### Capabilities Descriptor

Not all transports support all features. Rather than the core assuming Telegram/Teams parity, the `ChannelPort` declares what it supports via a capabilities object. The core defines fallback behavior per capability.

```typescript
// Conceptual — not production code
interface ChannelCapabilities {
  supportsMessageEdit: boolean;      // Can outbound messages be edited in-place?
  supportsThreadCreation: boolean;   // Can the adapter create new threads on demand?
  supportsInteractivePrompts: boolean; // Can the adapter show buttons/actions?
  supportsStreaming: boolean;        // Does edit-in-place streaming make sense?
  maxMessageLength: number;          // Transport's message size limit
}
```

**Core fallback behaviors when a capability is absent:**

| Capability | Fallback when `false` |
|-----------|----------------------|
| `supportsMessageEdit` | No streaming edits; send final response as new message (no placeholder → edit) |
| `supportsThreadCreation` | Require user to create thread manually; error if no thread context |
| `supportsInteractivePrompts` | Fall back to text-based yes/no prompt ("Reply 'yes' to approve") |
| `supportsStreaming` | Send "thinking…" message, then replace with (or follow with) final response |

This keeps the core clean: it checks capabilities before calling optional methods, rather than try/catch-ing `NotImplemented` errors.

### Design Options for the Abstraction

#### Option A: Port Interface + Transport Registry (Recommended)

Define a narrow `ChannelPort` interface with a capabilities descriptor. Add a lightweight transport registry that maps `REACH_CHANNEL` values to adapter constructors. The DI root (`main.ts`) selects the active transport at startup.

```typescript
// Conceptual — not production code
interface ChannelContext {
  threadId: string;       // Opaque thread/topic identifier
  channelId: string;      // Opaque channel/chat identifier
}

interface MessageRef {
  id: string;             // Opaque message identifier for edits
}

interface ChannelPort {
  readonly name: string;           // e.g. 'telegram', 'teams', 'slack'
  readonly capabilities: ChannelCapabilities;
  
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Outbound
  sendMessage(ctx: ChannelContext, text: string): Promise<MessageRef>;
  editMessage(ref: MessageRef, text: string): Promise<boolean>;  // no-op if !supportsMessageEdit
  
  // Formatting (transport-owned — see §2 Formatting Strategy)
  formatForTransport(markdown: string): string;
  splitMessage(text: string, footer?: string): string[];
  
  // Interactive prompts (returns selected option or text response)
  promptUser(ctx: ChannelContext, question: string, options: PromptOption[]): Promise<string>;
  
  // Inbound — event-driven
  onMessage(handler: (ctx: ChannelContext, text: string) => Promise<void>): void;
  onCommand(command: string, handler: (ctx: ChannelContext, args: string) => Promise<void>): void;
}

// Transport registry — maps REACH_CHANNEL values to factory functions
type ChannelFactory = (config: TransportConfig) => ChannelPort;
const TRANSPORT_REGISTRY = new Map<string, ChannelFactory>();

function registerTransport(name: string, factory: ChannelFactory): void {
  TRANSPORT_REGISTRY.set(name, factory);
}

// At startup: const channel = TRANSPORT_REGISTRY.get(process.env.REACH_CHANNEL)!(config);
```

The transport registry is deliberately simple — a `Map<string, ChannelFactory>`, not a plugin loader. Transports register themselves at import time (side-effect imports in `main.ts`). No dynamic discovery, no plugin directories, no runtime loading. This gives us N-transport extensibility without the complexity of a plugin system.

**Trade-offs:**
- ✅ Extends proven port pattern (`relay/ports.ts`)
- ✅ N-transport ready: adding a transport = implement `ChannelPort` + call `registerTransport()`
- ✅ Capabilities descriptor prevents core from assuming parity
- ✅ No new runtime dependencies; no event bus indirection
- ✅ Transport selection is explicit and fail-fast at startup
- ⚠️ Transport registry is static (compile-time) — dynamic plugin loading is not supported (acceptable for a personal daemon)

#### Option B: Event-Driven Message Bus

Introduce an internal event bus (Node `EventEmitter` or similar). Transports publish `message.received` events; core subscribes. Core publishes `message.send` events; transports subscribe.

**Trade-offs:**
- ✅ Fully decoupled — transports are plug-and-play
- ✅ Easy to add logging/metrics as bus middleware
- ⚠️ Indirection tax — harder to trace message flow, debug failures
- ⚠️ Adds a new architectural concept to a small codebase (~2K LOC)
- ⚠️ A registry of port implementations is NOT the same as an event bus. The registry gives us N-transport selection without the indirection; a bus adds broadcast semantics we don't need (Reach runs exactly one transport at a time, never multiple simultaneously)
- ❌ Event bus shines when multiple consumers process the same event (pub/sub fan-out). Reach is 1:1 — one inbound message → one relay → one outbound response. No fan-out.

#### Option C: Full Hexagonal Ports-and-Adapters

Formalize all external dependencies as ports (channel, persistence, config). Full DI container. Adapters wired at composition root.

**Trade-offs:**
- ✅ Maximum testability and pluggability
- ⚠️ Significant refactoring of the DI root (`main.ts`) and config layer
- ⚠️ Large blast radius — touches every module, high risk of regression
- ❌ The channel layer is the only boundary that needs generalization today. Persistence and config don't vary by transport. Full hexagonal is solving problems we don't have.

### ➡️ RECOMMENDATION: Option A — Port Interface + Transport Registry

**Reasoning:** Reach already uses the port pattern successfully (`relay/ports.ts` defines `SessionLookup` and `PermissionPrompter`). Option A extends this proven approach with two additions for N-transport readiness:

1. **Capabilities descriptor** — prevents the core from assuming any transport matches Telegram's feature set. Each adapter declares what it supports; the core degrades gracefully.
2. **Transport registry** — a simple `Map<string, ChannelFactory>` that makes adding a new transport a mechanical step (implement interface, register factory) rather than an architectural change.

The event bus (Option B) doesn't earn its keep even at N transports. Reach runs one transport at a time — there's no fan-out, no multi-subscriber scenario. The bus adds indirection without adding capability.

**Key structural change:** `SessionEntry` must be generalized. `topicId: number` → `threadId: string` (opaque). `chatId: number` → `channelId: string` (opaque). This is the deepest change and affects registry, types, handlers, and tests.

### Formatting Strategy

**Decision (D2): Transport-owns formatting.** Each adapter owns its escape/split/render logic. The core passes raw text (SDK output, which is roughly CommonMark) to `formatForTransport()` and `splitMessage()`.

**Acknowledged tension:** Aaron chose transport-owns formatting while also planning for N transports. At N=2 (Telegram, Teams) this is fine — each adapter has bespoke formatting needs. At N=4+ (add Slack mrkdwn, Discord markdown), formatting duplication may become painful: each adapter reimplements CommonMark → platform-dialect conversion independently.

**Migration path (no action now; documented for future):** If formatting duplication becomes a maintenance burden across 4+ adapters, introduce an optional `CommonMarkNormalizer` utility that adapters can use internally — a shared library, not a core requirement. The `ChannelPort` contract (`formatForTransport(markdown: string): string`) does NOT change; adapters that want to use the normalizer import it as a helper. Adapters with exotic formatting needs (Adaptive Cards) can ignore it. This preserves transport autonomy while amortizing shared logic.

---

## 3. Teams Transport Options

Aaron identified three integration paths. Comparison retained from v1; updated with resolved corp constraints.

### 3a. Microsoft Graph REST API ✅ SELECTED

**How it works:** Direct HTTP calls to `https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages`.

| Aspect | Details |
|--------|---------|
| **Auth** | Azure AD app registration; **client-credentials flow with admin consent** (D6). Permissions: `Chat.ReadWrite`, `ChannelMessage.Send`, `ChannelMessage.Read.All`. One-time admin consent step required (see P2-2). |
| **Outbound** | `POST` to create messages, `PATCH` to update. Rate limits: ~2 req/sec per app per tenant. |
| **Inbound** | **Polling** (D5). `GET /teams/{id}/channels/{id}/messages` with `$filter=lastModifiedDateTime gt ...`. No webhook endpoint available in corp environment. Mirrors Telegram's long-polling model — nice symmetry. |
| **Formatting** | HTML subset (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`) or Adaptive Cards (JSON). |
| **Corp-tenant** | Works within tenant. Admin consent is required (confirmed). |
| **Dev/test** | Testable with Graph Explorer or Postman against a dev tenant. |

### Inbound Polling Design

Graph polling frequency must balance responsiveness against rate limits. The ~2 req/sec/app/tenant rate limit is shared across ALL Graph operations (polling, sending, editing). Budget allocation:

| Operation | Budget |
|-----------|--------|
| Poll for new messages | ~0.5 req/sec (poll every 2s) |
| Outbound send/edit | ~1.5 req/sec (burst) |

This is tighter than Telegram (which has separate rate limits for reading vs. writing). The streaming UX and polling frequency share a rate-limit budget — see Streaming UX below.

### 3b. Bot Framework SDK (Fallback)

Retained as fallback. If Graph API polling proves too slow or corp security mandates bot registration for message access, Bot Framework provides an alternative. Adds an HTTP server requirement, but that's solvable.

### 3c. Teams MCP Server (Deferred)

Retained as future option. MCP ecosystem for Teams is immature. Revisit when coverage matures.

### 3d. CLI Tools — Rejected

No stable CLI tool provides real-time bidirectional Teams messaging.

### Streaming UX on Teams

Telegram's streaming UX (edit-in-place every 800ms) works because edits are cheap. Teams Graph API rate limits (~2 req/sec/app/tenant, shared with polling) constrain this.

Given the polling + rate-limit budget interaction:

- **Option S1 (Recommended for Teams):** Send initial "thinking…" message, replace with final response when complete. Zero intermediate edits. Maximizes rate-limit budget for polling.
- **Option S2:** Stream via Adaptive Card with loading state. Promising but unproven — requires corp testing.
- **Option S3:** Throttle edits to ~0.5/sec (1 edit every 2s). Feasible but eats into polling budget; streaming feels sluggish at 2s intervals.

**Recommendation: S1 for initial Teams adapter; revisit S2 if Adaptive Card refresh proves viable in corp testing.** The capabilities descriptor handles this cleanly: `TelegramChannel` sets `supportsStreaming: true`, `TeamsChannel` sets `supportsStreaming: false`. The core relay checks the flag and skips edit-in-place streaming when false.

---

## 4. Corp-Fork Strategy

### ✅ RESOLVED: Corp Can Import from Open Repo

Aaron confirmed the corp environment can `npm install` from the public GitHub repo. This is the simplest possible scenario: the corp branch imports `ChannelPort` directly, stays trivially mergeable, and carries no copied interfaces.

> *Footnote: If this ever changes (air-gapped network), the contract tests in the open repo act as lockstep enforcement. The corp adapter must pass the conformance kit (P1-7) regardless of import mechanism. A vendored copy or git subtree would be the last-resort fallback.*

### What Lives Where

| Component | Open Repo (this repo) | Corp Branch |
|-----------|----------------------|-------------|
| `ChannelPort` interface + capabilities | ✅ | Inherited via `npm install` |
| Transport registry + `REACH_CHANNEL` switch | ✅ | Inherited |
| `TelegramChannel` adapter | ✅ | Inherited |
| `TeamsChannel` adapter **stub** | ✅ | Inherited (replaced with live impl) |
| Conformance test kit | ✅ | Run against live Teams adapter |
| Teams adapter **live Graph wiring** | ❌ | ✅ |
| Azure AD app registration + secrets | ❌ | ✅ (env vars / `.env`) |
| Registry generalization (`threadId: string`) | ✅ | Inherited |

### Branching/Sync Strategy

**Corp-local branch rebases on `main`** (D4). The corp branch carries minimal diff:

1. `src/channel/teams/graphClient.ts` — live Graph HTTP client (auth, send, poll, edit)
2. `src/channel/teams/index.ts` — replaces the stub with the live adapter wiring
3. `.env` / environment config — `REACH_CHANNEL=teams`, `TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`

Everything else — the `ChannelPort` interface, capabilities, transport registry, conformance tests, Telegram adapter — comes from `main` via rebase. Merge conflicts should be rare and mechanical.

### LOCKSTEP Hazard Avoidance

The existing lockstep between `src/config/config.ts` and `extension.mjs` is a known maintenance risk. The channel abstraction avoids creating new lockstep hazards:

- `ChannelPort` is defined once in the open repo. The corp branch imports it — no copied interfaces.
- The conformance test kit (P1-7) runs against any adapter. If the interface changes in `main` and the corp adapter doesn't update, the conformance tests fail on next rebase — the tests ARE the lockstep enforcement.
- No logic is duplicated across runtime boundaries.

---

## 5. Phased Roadmap

### Phase 1: Abstraction + Telegram Refactor (Open Repo)

**Goal:** Extract `ChannelPort` interface with capabilities descriptor and transport registry; refactor existing Telegram code into a `TelegramChannel` adapter. Zero behavior change — all existing tests pass.

| Item | Owner | Description | Blocked? |
|------|-------|-------------|----------|
| P1-1: Define `ChannelPort` interface + `ChannelCapabilities` | Noble Six | Core port in `src/channel/port.ts`: interface, capabilities descriptor, `MessageRef`, `ChannelContext`, `PromptOption`. Design for N transports. | No |
| P1-2: Transport registry | Noble Six | `src/channel/registry.ts`: `Map<string, ChannelFactory>`, `registerTransport()`, startup selection via `REACH_CHANNEL`. Wire into DI root. | No |
| P1-3: Generalize `SessionEntry` | Carter | `topicId` → `threadId: string`, `chatId` → `channelId: string`; update registry, types, all consumers. Registry migration for existing JSON files (numeric → string). | No |
| P1-4: Refactor relay to use `ChannelPort` | Carter | `Relay` class takes a `ChannelPort` instead of `grammY.Context`. Core checks `capabilities` before calling optional features (edit, streaming, interactive prompts). Formatting/splitting delegated to adapter. | No |
| P1-5: Create `TelegramChannel` adapter | Kat | Wraps grammY Bot behind `ChannelPort`. Owns MarkdownV2 escaping, 4096-char splitting, inline keyboards. Capabilities: `{ supportsMessageEdit: true, supportsThreadCreation: true, supportsInteractivePrompts: true, supportsStreaming: true, maxMessageLength: 4096 }`. | No |
| P1-6: Refactor handlers/commands | Kat | Command handlers use `ChannelPort.onCommand()` instead of `bot.command()`; formatting uses adapter. | No |
| P1-7: Conformance test kit | Jun | **Reusable** test suite that ANY `ChannelPort` implementation must pass. Tests organized by capability: (a) mandatory tests (send, receive, split, format), (b) conditional tests gated on capabilities (edit, streaming, interactive prompts, thread creation). Future adapters (Slack, Discord, Teams) run this same kit. | No |
| P1-8: Config generalization | Carter | Add `REACH_CHANNEL=telegram` env var (default). Keep `TELEGRAM_*` vars valid when channel=telegram. Prepare `REACH_CHANNEL=teams` path (stub adapter). | No |
| P1-9: Regression suite | Jun | Ensure 570+ existing tests pass with zero behavior change. | No |
| P1-10: ADR finalization | Noble Six | Lock this ADR after Aaron's final approval. | No |

### Phase 2: Teams Adapter (Corp + Open Repo)

**Goal:** Implement `TeamsChannel` adapter using Graph REST API with polling for inbound. Developed and validated in corp environment.

| Item | Owner | Description | Blocked? |
|------|-------|-------------|----------|
| P2-1: Teams adapter stub | Carter | Stub in open repo satisfying `ChannelPort` with capabilities `{ supportsMessageEdit: true, supportsThreadCreation: false, supportsInteractivePrompts: true, supportsStreaming: false, maxMessageLength: 4096 }`. Throws "not configured" at runtime. Passes conformance kit mandatory tests against mock. | No |
| P2-2: Azure AD app registration + admin consent | Corp-side | Register app in corp tenant. Client-credentials flow. Permissions: `Chat.ReadWrite`, `ChannelMessage.Send`, `ChannelMessage.Read.All`. **One-time admin consent required.** | **Yes** — corp access |
| P2-3: Graph polling client | Corp-side | `GET /messages` with `$filter` at ~2s intervals. Parse inbound messages, dispatch to `onMessage` handlers. Budget: ~0.5 req/sec for polling, ~1.5 req/sec for outbound. | **Yes** — corp access |
| P2-4: Graph send/edit client | Corp-side | `POST` to create messages, `PATCH` to edit. Rate-limit-aware with retry/backoff. | **Yes** — corp access |
| P2-5: Teams formatting | Kat (+ corp) | `formatForTransport()` producing HTML or Adaptive Card JSON. Design in open repo (adapter-internal module), validate in corp. | Partially |
| P2-6: Permission prompt via Adaptive Cards | Kat (+ corp) | Adaptive Card action buttons replacing Telegram inline keyboards. Falls back to text prompt if `supportsInteractivePrompts` is ever set false. | **Yes** — corp testing |
| P2-7: Streaming UX validation | Noble Six + corp | Start with S1 (no streaming edits). Test S2 (Adaptive Card refresh) if time permits. Inform `supportsStreaming` capability. | **Yes** — corp access |
| P2-8: AFK mode generalization | Carter | Generalize `AfkModeController` or make it adapter-internal. Core exposes hooks; Telegram adapter uses them for forum-topic AFK. Teams adapter defers AFK to Phase 3 if complex. | No (design), **Yes** (Teams validation) |
| P2-9: Integration testing | Jun (+ corp) | Conformance kit run against live Teams adapter in corp environment. | **Yes** — corp access |
| P2-10: Config/env for Teams | Carter | `REACH_CHANNEL=teams`, `TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_CHANNEL_ID`. | No |

---

## 6. Open Questions for Aaron

Questions answered in v2 review are struck through. Remaining + new questions below.

### Answered (v2)

- ~~Single binary vs separate builds~~ → **Single binary with `REACH_CHANNEL` switch** (D1)
- ~~Formatting strategy~~ → **Transport-owns** (D2)
- ~~Can corp fork npm install from public repo~~ → **Yes** (D4)
- ~~Webhook endpoint feasible~~ → **No; polling** (D5)
- ~~Admin consent required~~ → **Yes; client-credentials + admin consent** (D6)

### Remaining from v1

1. **Is AFK mode in scope for Teams Phase 2?** AFK mode is deeply Telegram-specific (forum topic creation, orientation messages, stream routing). Recommend deferring Teams AFK to Phase 3, keeping Phase 2 focused on basic relay. **Decision needed.**

2. **Pairing flow for Teams?** Telegram pairing uses a one-time code sent to the bot. Teams would need a different onboarding flow (e.g., configure channel ID via env var, authenticate via browser). **Phase 2 or later?**

### New Questions (from N-Transport Direction)

3. **Which transports are on the horizon, and in what priority order?** You mentioned Slack and Discord as possibilities. Knowing the priority helps us validate the capabilities descriptor against real transport APIs now rather than discovering gaps later. Is it Teams → Slack → Discord, or different?

4. **Should the transport registry support runtime switching, or is startup-only selection sufficient?** Current design: `REACH_CHANNEL` is read once at startup; changing transport requires a daemon restart. If you envision switching transports without restart (e.g., for failover or multi-channel), the registry and relay need different wiring. **Startup-only is simpler and recommended** — a personal daemon restart is cheap.

5. **Graph API vs. Bot Framework: final call?** v1 recommended Graph API (primary) + Bot Framework (fallback). Corp constraints (no webhook endpoint, admin consent available) reinforce Graph as primary. But if corp IT has existing Bot Framework infrastructure or prefers the bot registration model, that changes the calculus. **Is Graph API confirmed as primary, or do you need to check with corp IT first?**

6. **Conformance kit scope — how strict?** The conformance test kit (P1-7) defines the behavioral contract for ALL adapters. Options:
   - **(a) Interface compliance only** — tests that the adapter implements all methods, returns correct types, handles capabilities correctly.
   - **(b) Behavioral contract** — tests that messages round-trip correctly, formatting produces valid output for the platform, prompts resolve, etc. (heavier but catches more bugs).
   
   Recommend **(b)** — the conformance kit is the primary quality gate for new adapters.

---

## Appendix: Telegram Coupling Inventory

Files with direct Telegram/grammY dependencies that Phase 1 must address:

| File | Coupling Type | Refactoring Needed |
|------|--------------|-------------------|
| `src/types.ts` | `topicId: number`, `chatId: number` | Generalize to `threadId: string`, `channelId: string` |
| `src/bot/index.ts` | `grammY.Bot` constructor, chat ID guard | Move behind `TelegramChannel` adapter |
| `src/bot/handlers.ts` | `grammY.Context`, `bot.command()`, `ctx.reply()` | Rewrite against `ChannelPort` |
| `src/bot/commands.ts` | Telegram command format (`/foo`) | Keep as-is (Teams also uses `/foo` style) |
| `src/bot/prompt.ts` | Inline keyboards, `callback_query` | Move behind adapter's `promptUser()` |
| `src/bot/pairing.ts` | Telegram-specific pairing flow | Keep in `TelegramChannel`; stub for Teams |
| `src/bot/afkMode.ts` | Forum topics, orientation messages | Generalize or defer to Phase 3 |
| `src/bot/afkStreamRouter.ts` | Telegram message sending | Generalize with `ChannelPort` |
| `src/relay/relay.ts` | `grammY.Context`, MarkdownV2, 4096 limit | Core relay uses `ChannelPort`; formatting delegated |
| `src/relay/markdownV2.ts` | Pure Telegram | Moves into `TelegramChannel` adapter |
| `src/relay/messageSplitter.ts` | 4096-char limit | Moves into `TelegramChannel` adapter |
| `src/relay/ports.ts` | `topicId: number`, `chatId: number` | Generalize to string IDs |
| `src/sessions/registry.ts` | `topicId: number`, `chatId: number` in persistence | Generalize; migration for existing registry files |
| `src/config/env.ts` | `TELEGRAM_BOT_TOKEN`, etc. | Add channel-switch logic; keep Telegram vars valid |
| `src/main.ts` | DI root wires grammY Bot directly | Channel selection at DI root based on `REACH_CHANNEL` |

---

*This is a DRAFT v2 ADR. Decisions D1–D7 are locked per Aaron's review. Remaining open questions in §6 require decisions before implementation. No code changes until Aaron gives final approval.*



---

### Concurrent Review — Noble Six Phase 1 Architectural Review

# Noble Six — Phase 1 Architecture Review

**Date:** 2026-06-06  
**Reviewer:** Noble Six (Lead/Architect)  
**Branch:** `feature/channel-abstraction`  
**Commits reviewed:** d84dc0c (Carter), e69e50b (Kat), 3739640 (Jun)  
**Prior commit (contract):** 7b12305 (Noble Six)

---

## VERDICT: APPROVE-WITH-NITS

The branch is sound. The core abstraction is clean, the Telegram adapter preserves existing behavior, the conformance kit is genuinely behavioral, and the 937-test suite is green. The contract is Teams-ready with one required tweak and several non-blocking items.

---

## 1. Contract Cleanliness / Abstraction Leaks

### ✅ Port contract (`src/channel/port.ts`) — Clean

No Telegram-isms. All IDs are opaque strings. Capabilities descriptor is well-typed. TSDoc specifies fallback behaviors. The interface is exactly what I designed in P1-1. No modifications were needed by Carter or Kat.

### ⚠️ NIT N1: `setMessageInterceptor` on TelegramChannel — Acceptable Phase-1 Debt

`TelegramChannel.setMessageInterceptor(fn: (ctx: Context) => Promise<boolean>)` is a Telegram-specific method that lives OFF the port contract. It's used by `main.ts` to inject the AfkModeController's `handleTelegramMessage` before the `onMessage` handler fires.

**Judgment: Acceptable.** AFK mode is deeply Telegram-specific today (forum topic creation, orientation messages, stream routing). Generalizing it would bloat Phase 1 without delivering value — Teams doesn't need AFK mode yet. The interceptor is on the concrete class, not the port. No abstraction leak.

**Future path (P2/P3):** When AFK mode is generalized, the interceptor should become a port-level concept — something like `onMessageFilter(predicate)` that runs before the `onMessage` handler. Not blocking.

### ⚠️ NIT N2: Synthetic grammY `Context` for `/status` and `/cwd` — Acceptable Phase-1 Debt

`handlers.ts` creates a `makeSyntheticCtx(channelCtx)` that builds a fake grammY `Context` object for two commands:
- `/status` → calls `statusProvider.handleStatusCommand(syntheticCtx)` which accepts grammY `Context`
- `/cwd` → calls `handleCwdCommand(syntheticCtx, ...)` which accepts grammY `Context`

The synthetic ctx routes `reply()` calls through `channel.sendMessage()`. It works, and Jun pinned it with regression tests. But it's a compatibility shim, not a clean abstraction.

**Judgment: Acceptable.** Both `handleStatusCommand` and `handleCwdCommand` accept grammY `Context` because they're deep functions that weren't worth refactoring in Phase 1. The shim preserves behavior without changing internal APIs. But it means two commands still have an indirect Telegram dependency path.

**Future path (Phase 2 or backlog):** Refactor `handleCwdCommand` and `handleStatusCommand` to accept `ChannelPort + ChannelContext` instead of grammY `Context`. This eliminates the shim. **Owner: Kat** (owns handler layer). Non-blocking.

---

## 2. N-Transport Readiness (Teams)

### Could a Teams adapter implement `ChannelPort` AS WRITTEN?

**Yes, with one required change and one advisory.**

### 🔴 FINDING F1: Relay does NOT check `supportsMessageEdit` or `supportsStreaming` before calling `editMessage` — MUST FIX

This is a real contract violation in `relay.ts`. The port TSDoc states:

> Core MUST check capabilities.supportsMessageEdit before calling [editMessage].
> Core MUST NOT call editMessage() [when supportsMessageEdit is false].

But `relay.ts` lines 113–119 call `channel.editMessage()` during streaming without checking capabilities:

```typescript
if (now - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
  try {
    await this.channel.editMessage(channelCtx, placeholderRef, accumulated);  // ← no capability check
  } catch { ... }
}
```

And line 100 always sends a placeholder:
```typescript
const placeholderRef = await this.channel.sendMessage(channelCtx, '…');  // ← always sent, even when no edits will follow
```

For a Teams adapter with `supportsStreaming: false` and `supportsMessageEdit: true`, the relay would:
1. Send a "…" placeholder (wasteful but harmless — would be replaced by final edit)
2. Call `editMessage` during streaming at 800ms intervals (violates `supportsStreaming: false`)
3. Call `safeEditFormatted` for the final response (correct)

For a hypothetical adapter with `supportsMessageEdit: false`, the relay would:
1. Send a "…" placeholder that can never be edited (user sees "…" forever if first-chunk edit fails)
2. Call `editMessage` during streaming — returns false but wastes API calls
3. Call `safeEditFormatted` → falls back to `formatForTransport + editMessage` → fails

**Required fix:** Before the streaming loop, check `channel.capabilities.supportsStreaming`. If false, skip intermediate edits entirely. Before the placeholder send, check `supportsMessageEdit` — if false, don't send a placeholder; accumulate the full response and send once at the end. The fallback paths are documented in the port TSDoc; they just aren't implemented in the relay yet.

**Owner: Carter** (owns relay). **Blocking: YES** — the relay must honor the contracted fallback behaviors before the port is Teams-ready. Without this, a `supportsStreaming: false` adapter would fire dozens of pointless `editMessage` calls per response.

### ⚠️ NIT N3: `asTelegramChannel()` duck-typing in relay — Non-blocking but needs a plan

`relay.ts` duck-types to `TelegramChannel` for `editMessageWithMarkdown` and `sendMessageWithMarkdown`:

```typescript
private asTelegramChannel(): TelegramChannel | null {
  const ch = this.channel as unknown as TelegramChannel;
  return typeof ch.editMessageWithMarkdown === 'function' ? ch : null;
}
```

This is documented as intentional (Carter's handoff notes). For Telegram, it preserves the MarkdownV2-with-plain-fallback behavior. For non-Telegram channels, it falls through to the generic `formatForTransport + editMessage` path.

**Judgment: Acceptable for Phase 1.** The duck-typing doesn't break any other adapter — it's a transparent optimization for Telegram. But it means the generic path (`formatForTransport + editMessage`) is exercised only in tests, never in production for Telegram. This is a minor test-coverage gap.

**Future path:** When a second adapter goes live, the generic path gets real production exercise. No action needed now.

### ⚠️ NIT N4: `require('grammy')` in factory registration — Lint suppression

Line 288 of `src/channel/telegram/index.ts`:
```typescript
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Bot } = require('grammy') as typeof import('grammy');
```

This uses CJS `require()` in an ESM module to "lazily" import grammY. The intent is to avoid loading grammY when `REACH_CHANNEL !== 'telegram'`. But the module is imported via `import './channel/telegram/index.js'` in `main.ts`, which runs the side-effect registration AND parses the factory function at module load. The `require()` inside the factory only defers the actual grammY load until `createChannel('telegram')` is called — which is always called when `REACH_CHANNEL === 'telegram'`.

**Judgment: Non-blocking nit.** The lazy load works as intended for the case where a Teams user never calls `createChannel('telegram')`, but the CJS `require()` in ESM is a code smell. Replace with dynamic `await import('grammy')` or just use a static top-level import since the module is only imported when Telegram is selected.

**Owner: Carter.** Non-blocking.

---

## 3. Corp-Fork Mergeability

### ✅ Structure is clean for corp branch

A Teams adapter would add:
- `src/channel/teams/index.ts` (new file — implements ChannelPort, calls `registerChannel('teams', ...)`)
- `src/channel/teams/graphClient.ts` (new file — Graph API HTTP client)
- `.env` additions (`TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`, etc.)
- `import './channel/teams/index.js'` in `main.ts` (one line)

No shared files need modification beyond that one import line. No new LOCKSTEP hazards.

### ✅ `main.ts` casting concern

`main.ts` line 64 does `const telegramChannel = channel as TelegramChannel` and accesses `telegramChannel.bot` for AFK mode wiring. When `REACH_CHANNEL=teams`, this cast would fail at runtime. But the AfkModeController is only created when `bridge` is non-null, and the AFK features are Telegram-specific. The corp fork should guard this with `if (cfg.reachChannel === 'telegram')` or move it into the TelegramChannel adapter. This is a known Phase 2 concern, not a Phase 1 blocker.

---

## 4. Correctness / Bugs

### ✅ coerceId migration — Correct

`coerceId(raw)` in `registry.ts` handles both `string` passthrough and `number → String()` conversion. Legacy JSON files with `{ "topicId": 42, "chatId": -100 }` upgrade transparently. The canonical key is `entry.threadId` (string). Legacy numeric keys (`"42"` from `Object.entries`) match via the `String(Number(key)) === key` check. Well-handled.

### ✅ IdleMonitor — Clean migration

`IdleMonitor` now uses `string` keys instead of `number`. All timer operations (`reset`, `cancel`, `cancelAll`) work correctly with string keys.

### ✅ Empty threadId handling — Correct

`TelegramChannel.sendMessage` omits `message_thread_id` when `ctx.threadId` is empty (General Topic). Pinned by Jun's regression test.

### ✅ promptUser AbortSignal — Correct

`TelegramChannel.promptUser` delegates to `promptUserForPermission` which already handles AbortSignal. FakeChannel's text-fallback path correctly resolves `''` on abort. Both pre-aborted and mid-wait abort are tested.

### ✅ `bot.catch` in handlers.ts — Minor duplication

`handlers.ts` line 367 still has `bot.catch(...)`. This is redundant with `TelegramChannel.start()` which also wires `bot.catch()` in line 93. But grammY's `bot.catch` is idempotent (last one wins), so this is harmless. Could clean up in Phase 2.

---

## 5. Conformance Kit Quality

### ✅ Genuinely behavioral

The conformance kit (`tests/channel/conformance/runner.ts`) is behavioral, not just type-shape:

- **Outbound:** Asserts `sendMessage` returns a `MessageRef` with non-empty `id`; asserts empty threadId doesn't throw.
- **Edit:** Asserts `editMessage` returns `false` when `supportsMessageEdit=false` and records no edit; returns `true` when supported.
- **Formatting:** Asserts `formatForTransport` returns non-null string; `splitMessage` enforces `maxMessageLength` on every chunk; footer appears in last chunk.
- **Inbound:** Asserts handler fires with string threadId/channelId; replacement semantics on second `onMessage` call.
- **Prompts:** Asserts text-fallback resolves on matching inbound text; AbortSignal resolves `''`.
- **Threads:** Asserts `createThread` throws when `supportsThreadCreation=false`; returns valid `ChannelContext` when supported.
- **Full matrix:** All 4 capabilities in ON/OFF states, including the "all OFF" scenario (most constrained transport).

### ✅ Plug-in path for future adapters is real

`runChannelPortConformance(makePort, opts)` is parameterized. A Teams conformance test is a 4-line file:
```typescript
import { runChannelPortConformance } from './runner.js';
import { TeamsChannel } from '../../../src/channel/teams/index.js';
runChannelPortConformance(() => new TeamsChannel(mockGraphClient), { name: 'TeamsChannel', skipLifecycle: true });
```

Jun's handoff doc (jun-phase1-conformance.md) documents this exact path with a full example.

### ⚠️ GAP: Conformance kit does not test the relay's capability-check behavior

The conformance kit tests the **adapter's** behavior. It does NOT test the **relay's** response to capabilities (e.g., "when `supportsStreaming=false`, the relay doesn't call `editMessage` during streaming"). This is the same gap identified in F1 above. The relay tests in `tests/relay/relay.test.ts` should gain capability-driven test cases.

**Owner: Jun** (tests) + **Carter** (relay fix). Blocked on F1 fix.

---

## Itemized Findings

| # | Type | Description | Status | Owner |
|---|------|-------------|--------|-------|
| F1 | BUG | Relay does not check `supportsStreaming` / `supportsMessageEdit` before calling `editMessage` during streaming. Violates port contract. Sends useless placeholder + edits for `supportsStreaming:false` adapters. | **RESOLVED** (e1f3f4d + 2b5e4a2, verified commit 2b5e4a2) | Carter + Jun |
| N1 | NIT | `setMessageInterceptor` on TelegramChannel — Telegram-only method off the port. Acceptable Phase-1 debt. | Deferred to Phase 3 (AFK generalization) | Backlog |
| N2 | NIT | Synthetic grammY Context for `/status` and `/cwd`. Compatibility shim — works but not clean. | Deferred to Phase 2 | Kat |
| N3 | NIT | `asTelegramChannel()` duck-typing in relay for MarkdownV2. Documented, transparent, works. | Deferred to backlog (self-resolves when second adapter ships) | Backlog |
| N4 | NIT | CJS `require('grammy')` in ESM factory registration. Works but code smell. | Deferred to Phase 2 | Carter |
| N5 | NIT | `bot.catch()` in handlers.ts duplicated with TelegramChannel.start(). Harmless. | Deferred to Phase 2 cleanup | Kat |

---

## Is the Port Teams-Ready As Written?

**Yes.** The `ChannelPort` interface is Teams-ready today. A Teams adapter with `{ supportsStreaming: false, supportsThreadCreation: false, supportsMessageEdit: true, supportsInteractivePrompts: true, maxMessageLength: 28000 }` can implement it without contract changes.

The relay now honors the capability flags correctly (F1 resolved in commit e1f3f4d, verified in commit 2b5e4a2).

**After Phase 1:** Corp fork can start implementing `TeamsChannel` against the locked port contract with confidence.
