# Jun → Coordinator: F1 Relay Capability Verification

**Date:** 2026-06-06
**Branch:** `feature/channel-abstraction`
**Verifying commit:** e1f3f4d (Carter's F1 fix)
**New test file:** `tests/relay/relay.capabilities.test.ts`

---

## What Was Added

Nine new relay-level tests in `tests/relay/relay.capabilities.test.ts` that
drive the **real** `Relay` class against mock channels configured for each of
Carter's three capability cases. These tests were written after reading
Carter's spec (`carter-f1-relay-capability-fix.md`) and the fixed relay code —
pure independent verification, no coordination with the author.

### Case B — `supportsMessageEdit:false` (4 tests)

| Test | Asserts |
|---|---|
| never calls editMessage on normal response | `editMessage` call count === 0 |
| sendMessage called exactly once with full response | `sendMessage` called 1×, arg contains assembled text |
| no "…" / "thinking…" placeholder | single sendMessage arg is NOT a placeholder |
| error path | `editMessage` still 0; `sendMessage` once, starts with `"❌ Error:"` |

### Case C — `supportsStreaming:false, supportsMessageEdit:true` (4 tests)

| Test | Asserts |
|---|---|
| first sendMessage is "thinking…" | `sendMessage` 1st call arg === `'thinking…'` |
| editMessage called exactly once — final replacement | `editMessage` count === 1, arg contains full response |
| **editMessage stays 1 across 12 chunks with timer-advancing iterator (anti-regression)** | `editMessage` count === 1; all 12 chunk strings present in the single edit |
| error path | `sendMessage` once (`'thinking…'`); `editMessage` once with `"❌ Error:"` |

### Case A — `supportsStreaming:true, supportsMessageEdit:true` (1 test)

Regression guard confirming the Telegram path still sends `"…"` placeholder
and edits with the assembled response — guards against future regressions that
would break Case A while adding new capability branches.

---

## Why the Case-C Edit-Count Test Would Fail on Pre-F1 Code

The critical test is:

> *"editMessage count is exactly 1 even with 12 stream chunks and
> throttle-advancing timers"*

**Mechanism:**  The async iterator in the test calls
`vi.advanceTimersByTime(1000)` after each `yield`, advancing fake clock time
by 1 second (> the 800ms throttle window) between every chunk.

**Pre-fix behavior:** The pre-fix relay had no capability branch — every
channel went through the Case A loop which called `editMessage` inside a
`Date.now() - lastEditAt >= 800` guard. With the clock advancing 1000ms per
chunk, that guard would be `true` on every iteration, resulting in
`editMessage` being called once per chunk (12 calls for 12 chunks).

**Fixed behavior (Case C):** The `for await` loop accumulates without any
`editMessage` calls. Only the unconditional `safeEditFormatted` after the loop
fires — exactly 1 call, regardless of chunk count.

The test asserts `toHaveBeenCalledTimes(1)`, which would **fail** on pre-fix
code (12 calls) and **pass** on the fix (1 call).

The `"thinking…" vs "…"` sendMessage assertion is the secondary discriminator
and would also fail on pre-fix code (which sends `"…"` for every channel).

---

## FINDINGS

**None.**

Carter's fix is complete and correct. All nine new tests pass against commit
e1f3f4d. The relay honors all three capability cases as specified:

- ✅ Case B: `editMessage` never called; single `sendMessage` with full response
- ✅ Case C: `"thinking…"` placeholder; accumulates silently; exactly one `editMessage`
- ✅ Case A: `"…"` placeholder; throttled edits; final edit with assembled response

**F1 fix verified — relay honors capabilities.**

---

## Test Counts

- Baseline before this work: **937** tests
- After adding 9 new capability tests: **946** tests
- `tsc --noEmit`: clean
- `npm run lint`: clean (lint targets `src/` only)
- `npx vitest run`: **946 passed | 4 skipped | 1 todo** — zero regressions
