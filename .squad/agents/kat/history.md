# Kat — History (Summarized 2026-05-30)

## Identity & Role

- **Agent:** Kat (Backend Dev, AFK Mode Implementation, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** AFK mode controller, stream routing, relay re-targeting, Telegram topic lifecycle, permission integration
- **Joined:** 2026-05-07

## Current Status

**Phase 8 COMPLETE.** F4 soft refactor shipped 2026-05-28 (stream router extraction: 133 LOC). AFK mode stable (649 LOC in afkMode.ts). Fleet validation (A6-6) passed: N=20 concurrent closes, timeout-bounded, 429 retry-safe.

**Test baseline:** 517 passed / 4 skipped / 0 failed. tsc clean, lint zero warnings.

---

## Phases 1–7 Highlights

**Phase 7 (ADR-11 Implementation):** AFK mode controller with machine-wide mode state, session↔topic mapping, relay re-targeting (CLI ↔ Telegram mirror), and Telegram topic lifecycle (create/reopen/close with serialization + exponential backoff).

**Key Invariants (Discovered in PR Cycles):**
- Compensation must serialize against ctivationPromise (prevents resurrection race)
- Registry lastTopicId cleared on rollback (force fresh topic on retry)
- Detached close burst: timeout-bounded (7 s), per-call retry-bounded (4 attempts)
- AbortController wiring for disconnect → clean pending mirror/stream state
- Full buffer kept in state; only display slice capped (4096 Telegram limit)

**PR #7 Production Fixes:**
- Timer leak in compensatePartialActivation (Promise.race) → fixed with clearTimeout in finally
- Placeholder retry guard: messageId === undefined check + buffer-before-network ordering
- handleError race guard: isActive() check after state cleanup
- Empty Set leak: emoveRequestId helper deletes Set when empty

**Architectural Patterns:**
- Narrow AfkBridgePort interface for dependency injection (not concrete bridge)
- AfkModeController.forTesting() seam with DTO-based state seeding
- Stream routing extracted to fkStreamRouter.ts (133 LOC, single responsibility)

---

## Mirror Rate Limiter (Future Extract)

llowMirrorInput + mirrorRates/globalMirrorRate identified as second cohesive extractable subsystem. Not acted on (fkMode.ts at 649 LOC, comfortably under 700). Natural trigger: if file approaches 700 LOC or rate-limit logic gains complexity.

---

## Bridge Session (Phase 6)

- BridgeSession async-queue adapter (push-to-pull for relay streaming)
- Permission callback integration (ADR-9 no-timeout + AbortSignal)
- Multiplexed sessionId filtering
- 316 passing tests

---

## Phase 8 Dogfood Fixes (2026-05-29T22:34:52-07:00)

**Branch:** `user/aaron/dogfood-bugs-3-4`  
**Commit:** `fix(dogfood): dedupe /back banner + restore friendly session name in topic titles`

### Bug #3 — Duplicate "🖥️ Back at desk" banner (FIXED)

**Root cause:** When `/back` is run, `afkMode.ts:deactivate()` sends BOTH `back.confirmed`
(session-scoped, guarded by `isForCurrentSession`) AND `mode.changed { active: false }` (broadcast
to ALL sessions) to every registered session. In `extension.mjs`, `handleBackConfirmed` showed
the banner AND `handleModeChanged(active=false)` also showed the banner — so the calling session
received two banners.

**Fix:** `handleModeChanged` for `active === false` is now silent. `handleBackConfirmed` is the
sole owner of the "Back at desk" banner. The `mode.changed` event is a data event; the
`back.confirmed`/`afk.activated` pair are the user-visible display events.

**File changed:** `extension.mjs` — `handleModeChanged` function  
**Test added:** `tests/bridge/extension-back-banner.test.ts` — 5 tests covering back.confirmed
emits banner, mode.changed active=false is silent, both events together = exactly one banner.

### Bug #4 — Topic title shows `sessionId (sessionId)` (FIXED)

**Root cause:** `extension.mjs` line 143: `SESSION_NAME` falls back to `SESSION_ID` (a UUID)
when the CLI does not export the `SESSION_NAME` env var. The topic title format at
`afkMode.ts:451` is correct (`${session.sessionName} (${session.sessionId})`); the bug was
upstream in how `sessionName` is populated. SDK `joinSession()` does not expose a `name` field,
so the extension can't derive a friendly name from the session object.

**Fix:** Fall back to `path.basename(process.cwd())` (e.g. `verbose-invention`) before falling
back to `SESSION_ID`. `basename` added to the existing `node:path` import.

**File changed:** `extension.mjs` — `SESSION_NAME` constant declaration  

**Test baseline after fixes:** 538 passed / 4 skipped / 0 failed. tsc clean, lint zero warnings.



---

## No Blockers

- AFK mode production-ready
- F4 refactor complete and tested
- A6-6 fleet validation closed
- All invariants documented
- Ready for ship-to-pr or Phase 9
