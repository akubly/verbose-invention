# Kat — History (Summarized 2026-05-30 → Phase 9 complete)

## Identity & Role

- **Agent:** Kat (Backend Dev, AFK Mode Implementation, Config & Secrets, README Docs)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** AFK mode controller, stream routing, relay re-targeting, config validation, secret redaction
# Kat — History (Summarized 2026-05-30 → Phase 8.5 complete)

## Identity & Role

- **Agent:** Kat (Backend Dev, AFK Mode Implementation, README Docs, Sonnet 4.6 → Haiku 4.5 for Task 4)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** AFK mode controller, stream routing, relay re-targeting, Telegram topic lifecycle, permission integration, **install documentation** (Phase 8.5 Task 4)
- **Joined:** 2026-05-07

## Current Status

**Phase 9 COMPLETE. Cycle 3 README fixes shipped.** Cycle 1: I10 (validatePath warning) + I11 (redactSecrets module) shipped. Cycle 2: Verified + ProgramData deferred. Cycle 3: Skeptic caught docs drift (TELEGRAM_ALLOWED_USER_IDS + REACH_PERMISSION_POLICY + /resume signature) — fixed in README.md. Branch user/aaron/phase9 (4 commits ahead), 783 tests passing. Ready for merge.

**Test baseline:** 783 passed / 4 skipped / 1 todo. tsc clean, lint zero warnings.
**Phase 8.5 COMPLETE.** README install section rewritten 2026-05-30 (Quick Start, Installation, Dev Workflow, Upgrading, Uninstall, Platform Support). −17 lines net (consolidation). All scripts referenced will exist when Task 2 (Carter orchestrator) completes.

**Phase 8 COMPLETE.** F4 soft refactor shipped 2026-05-28 (stream router extraction: 133 LOC). AFK mode stable (649 LOC in afkMode.ts). Fleet validation (A6-6) passed: N=20 concurrent closes, timeout-bounded, 429 retry-safe.

**Test baseline:** 570 passed / 4 skipped / 0 failed (was 517, now +33+4 new). tsc clean, lint zero warnings.

---

## Major Work Summary

### Phase 9 — Secret Redaction & Config Validation (Cycles 1–3)

**Cycle 1 – I10 & I11:**
- **I10 — validatePath warning:** Extended return type `{ ok: true; normalized: string; warning?: string }`. Windows-only sensitive-prefix detection (WINDIR, Program Files, other users). Junction/symlink resolution. Caller surfaces warning before adding entry (warn-not-block per Aaron).
- **I11 — redactSecrets module:** Daemon-side regex engine with 3 pattern groups (keyword-adjacent, high-entropy base64, URL-embedded). Over-redaction bias. Called from afkMode.ts before Telegram delivery. Module: `src/bot/redactSecrets.ts`.

**Cycle 2 – Verification:**
Verified implementations. Security reviewer diagnosed AWS key leakage (missing `/` and `+` in base64 charset) — fixed by Carter in C2-I1. ProgramData prefix noted for Phase 10.

**Cycle 3 – README Documentation Drift (Kat):**
Skeptic flagged three docs-vs-runtime mismatches:
- **TELEGRAM_ALLOWED_USER_IDS:** README listed as "Required"; runtime treats as optional. Reclassified to "Strongly Recommended" with security callout: "If not set, ANY user in the configured Telegram chat can control the daemon."
- **REACH_PERMISSION_POLICY:** Default `approveAll` blocks Telegram mirror input (safety measure). Added full policy descriptions to Configuration section and Environment Variables table.
- **/resume command:** README showed `/resume` with no argument; implementation requires `/resume <session-name>`. Fixed. Spot-checked all other command signatures (`/new`, `/list`, `/remove`, `/pair`, `/help`, `/status`, `/cwd`) — all match.

Decision doc: `.squad/decisions/inbox/kat-phase9-review-cycle3-readme.md`

### Phase 8.5 — Install Documentation

README install section rewritten. Quick Start, Installation subsections, Dev Workflow, Upgrading, Uninstall, Platform. Net −17 lines (consolidation).

### Phase 8 — AFK Mode Stable

F4 refactor: stream router extracted (133 LOC). AFK mode 649 LOC. Fleet validation passed (N=20 concurrent).

### Phase 7 & Earlier — AFK Mode, Protocol Drift, PR Cycles

ADR-11 implementation (machine-wide mode state, session↔topic mapping, relay re-targeting). Key invariants: compensation serialization, registry lastTopicId on rollback, detached close timeout-bounded. Protocol drift tests established.

---

## Key Learnings

**Phase 9 I10 Pattern:** When a regex makes a runtime check impossible (e.g., `ALIAS_REGEX` blocks all `-` prefixes), remove the check and document the invariant in regex JSDoc instead of dead code.

**Phase 9 I11 Pattern:** Pattern order matters in regex replacements. Run most-specific first (keyword-adjacent) so captured groups are replaced before later passes see them, avoiding double-matches.

**exactOptionalPropertyTypes:** Return `{ ok: true, normalized, warning }` without including `warning: undefined` as separate branches. Applies to all objects with optional fields.

**Cross-file citations:** Use symbol names instead of line numbers (`handlers.ts — bot.command('new', ...)` not `handlers.ts:53`). Symbols remain stable across refactors.

**EventEmitter tuple types:** Updating tuple type cascades correctly through generic overload in interface. Check protocol-drift test when adding optional fields.

---

## Phase 10 Backlog

- ProgramData prefix added to sensitive-dir list
- Cross-platform path detection in /new --cwd (Unix support)

---

## Phase 9 Cycle 3 Update (2026-05-31)

Cycle 3 README fixes (A1 + A2) shipped in commit 41a584e. Skeptic's findings addressed:
- ALLOWED_USER_IDS reclassified "Strongly Recommended" with security callout
- REACH_PERMISSION_POLICY expanded with side-effect warning
- /resume signature corrected to `/resume <session-name>`
- Spot-check verified all 8 command signatures (no sibling drift)

Branch user/aaron/phase9 now 9 commits ahead. Suite stable at 783 tests. Ready for PR. No further review cycles required.
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

## Learnings

### Phase 8.5 Task 4: README Install Section Update (2026-05-29T23:36:10-07:00)

**Key insight:** Script names don't always align with documentation timing. Aaron's locked decisions set the final names (`npm run init`, not `npm run install`/`setup`), but the scripts themselves are implemented in Task 2 (orchestrator). Kat's job (Task 4) was to document the *design* (Aaron's decisions), not the implementation state.

**Decision:** Documented the README using Aaron's final design decisions, flagged the script name mismatches in the decision file, and noted when Task 2 will add them.

**Pattern recognized:**
- Phase 8.5 tasks are ordered: Task 1 (unblock) → Task 3 (test) → Task 2 (orchestrator) → Task 4 (docs)
- Docs should drive from locked decisions, not from current implementation status
- Flag mismatches so next session knows what to expect

**README refactor summary:**
- Collapsed 65 lines of setup/service installation into 48 lines (−17 line net)
- Replaced prescriptive steps with outcome-focused sections: Quick Start → Installation → Dev → Upgrading → Uninstall → Platform
- Consolidated old "Setup" + "Windows Service" sections into streamlined "Installation" with subsections
- Added "Development Workflow" section to surface the `NODE_ENV=development` junction trick for fast iteration
- Preserved all existing env var details, added new emphasis on `TELEGRAM_ALLOWED_USER_IDS` (security requirement)

**Pattern for future doc updates:**
- Start with Aaron's locked decisions, not current code state
- Flag mismatches clearly (decision file)
- Docs update is lean and fast — most work is thinking about structure, not writing

---
