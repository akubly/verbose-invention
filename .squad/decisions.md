> 📦 Entries from 2026-05-22 and earlier archived to decisions-archive-2026-05-29.md on 2026-05-29.

---

# Phase 8.5: Reach Install Story (Decision)

**Date:** 2026-05-29T22:22:08-07:00  
**Author:** Noble Six (Lead / Architect)  
**Status:** Design Complete — Ready for Phase 8.5 Execution

# Noble Six — Install Story Decision

**Date:** 2026-05-29T22:22:08-07:00  
**Author:** Noble Six (Lead / Architect)  
**For:** Squad team (Carter, Kat, Jun, Scribe)  
**Full doc:** `.copilot/reach-install-handoff.md`

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

# PR #7 Cloud Review Cycle Dispositions (Phase 8)

**Date:** 2026-05-28  
**Cycles:** 1–4 (Extended: Real production bugs found)  
**Owner:** Kat (Bot Dev)  
**Status:** All findings addressed; branch f78ccd6 awaiting PR

## Dogfood Bug Fixes (#3, #4)

# Kat — Dogfood Bugs #3 and #4 Fix Notes

**Date:** 2026-05-29T22:34:52-07:00  
**Branch:** `user/aaron/dogfood-bugs-3-4`  
**Author:** Kat (Bot Dev)

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

## Cycle 1 — afkStreamRouter.ts State Leaks

# kat-pr7-cycle1 — PR #7 Copilot Review Fixes

**Date:** 2026-05-28T22:45:13-07:00  
**Author:** Kat  
**Branch:** user/aaron/phase-8  
**Commit:** 09d0c40

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

## Cycle 2 — handleChunk Placeholder Retry

# Decision Note — PR #7 Cycle 2: handleChunk Placeholder Retry

**Date:** 2026-05-28T22:45:13-07:00  
**Author:** Kat (Bot Dev)  
**File:** `src/bot/afkStreamRouter.ts` — `handleChunk`  
**Commit:** `2f12755`

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

## Cycle 3 — Telegram Display Cap + isActive Guard

# Decision Note — PR #7 Cycle 3
**Author:** Kat  
**Date:** 2026-05-28T23:25:16-07:00  
**File:** `src/bot/afkStreamRouter.ts`

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

## Cycle 4 — Production Bug: Timer Leak + Fleet Tests

# Decision Note — PR #7 Cycle 4 (Kat)

**Date:** 2026-05-28T23:25:16-07:00  
**Author:** Kat  
**Context:** Copilot code review cycle 4 on PR #7 (extended past maxCycles by Aaron — real production bug found).

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


# Phase 8 Dogfooding Plan (2026-05-29)

**Date:** 2026-05-29T21:53:17-07:00  
**From:** Noble Six (Lead/Architect)  
**Status:** Ready for Aaron's execution

## Summary

Comprehensive dogfooding plan synthesized from Phase 6 checklist, Phase 7 ADR-11 decisions, and Phase 8 P1+watch sweep deliverables. Validates production-facing behavior before Phase 9 design decisions lock in.

**Location:** `.copilot/reach-dogfood-plan-phase8.md`

## What Was Tested

Phase 8 completed four hardening items:
1. **Permission prompting edge cases** (ADR-9, no-timeout guarantee)
2. **AFK mode fleet binding & stream routing** (ADR-11 + F4 refactor)
3. **Multi-chunk stream truncation & edge cases** (Cycle 3 fixes)
4. **Config guard for deny-all protection** (N2 guard)

## Plan Structure

**4 scenario groups, 16 total scenarios:**

| Group | Scenarios | High-Risk Behavior |
|-------|-----------|-------------------|
| A: Permission Prompting | 5 | No-timeout guarantee, concurrent prompts, deny execution |
| B: AFK Mode | 6 | Auto-binding, fleet join, mid-stream deactivation |
| C: Stream Routing | 6 | Truncation, empty placeholder, transient failure, race conditions |
| D: Config Guard | 2 | Deny-all fatal exit + actionable message |

**Success bar:** ≥80% green (≥13/16), zero critical severity.  
**Time estimate:** 45–90 minutes.

## Key Architectural Notes

### Mirror Rate Limiter Extraction (Future)

During F4 soft refactor (watch sweep), identified `allowMirrorInput` + `mirrorRates`/`globalMirrorRate` as a second cohesive extractable unit. Not extracted now because `afkMode.ts` is comfortably under 700 LOC post-refactor (649 LOC).

**Natural trigger:** Extract when file approaches 700 again or rate-limit logic gains complexity.

### ADR-10 Pipe Token Validation

Pipe authentication (token validation on extension side) is documented but not implemented. Not a blocker for Phase 8 dogfooding on solo machine, but is a pre-production gap flagged for Phase 9+.

## Triage Protocol

**Critical (data loss, security):** File immediately, halt dogfooding.  
**High (command fails, stream broken):** File immediately, continue other scenarios.  
**Medium (UX friction, edge case):** Capture in "dogfood findings" issue after session.

All issues labeled `squad` for team visibility.


