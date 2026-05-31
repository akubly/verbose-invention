# Kat — History (Summarized 2026-05-30 → Phase 8.5 complete)

## Identity & Role

- **Agent:** Kat (Backend Dev, AFK Mode Implementation, README Docs, Sonnet 4.6 → Haiku 4.5 for Task 4)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** AFK mode controller, stream routing, relay re-targeting, Telegram topic lifecycle, permission integration, **install documentation** (Phase 8.5 Task 4)
- **Joined:** 2026-05-07

## Current Status

**Phase 8.5 COMPLETE.** README install section rewritten 2026-05-30 (Quick Start, Installation, Dev Workflow, Upgrading, Uninstall, Platform Support). −17 lines net (consolidation). All scripts referenced will exist when Task 2 (Carter orchestrator) completes.

**Phase 8 COMPLETE.** F4 soft refactor shipped 2026-05-28 (stream router extraction: 133 LOC). AFK mode stable (649 LOC in afkMode.ts). Fleet validation (A6-6) passed: N=20 concurrent closes, timeout-bounded, 429 retry-safe.

**Test baseline:** 570 passed / 4 skipped / 0 failed (was 517, now +33+4 new). tsc clean, lint zero warnings.

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

### Phase 9 Item 1: Orientation Message + /status (2026-05-30)

**Key insight:** The "cheap path" for orientation data (cache `assistant.message` SDK events in the extension, send with `afk.request`) is genuinely cheap — ~15 LOC in the extension, ~3 LOC in protocol, ~50 LOC in daemon. No new SDK calls, no token cost, no latency.

**EventEmitter tuple type pattern:** When updating `AfkBridgeEvents`, updating the tuple type `[sessionId: string, lastAssistantExcerpt?: string]` cascades correctly through the generic `on<K>()` overload in `AfkBridgePort`. No need to manually update the concrete `on()` overloads in the port interface.

**Protocol drift tests:** The project has a test (`extension-protocol-drift.test.ts`) that parses the protocol.ts source and asserts exact field lists for each message type. Any new optional field requires updating this test. Check it whenever adding protocol fields.

**Test expectation precision:** When an EventEmitter now emits `(sessionId, undefined)` instead of `(sessionId)`, Vitest's `.toHaveBeenCalledWith(sessionId)` fails because the call signature includes the extra `undefined` arg. Fix: `.toHaveBeenCalledWith(sessionId, undefined)`.

**Plain text vs MarkdownV2 convention:** Topic messages use `safeSendMessage()` (plain text, no `parse_mode`). General/summary messages use MarkdownV2. The distinction is: per-session topic content → plain text; group-level summary → MarkdownV2. Follow this when formatting new messages.

**Carter coordination:** Phase 9 Item 2 (pass-through) relies on `isBotCommand()` returning `true` for daemon commands so they're NOT forwarded to the CLI. Any new bot command (like `/status`) MUST be added to `BOT_COMMANDS` in `commands.ts` to prevent it from being passed through to the CLI session.


### Phase 9 Item 3 Task 5: Config Schema + knownCwds Helpers (2026-05-30T11:46:28-07:00)

**Files created/modified:**
- `src/config/config.ts` — Added `KnownCwd` interface + `knownCwds?: KnownCwd[]` to `ReachConfig`
- `src/config/knownCwds.ts` — New helpers module (8 exports)
- `.squad/decisions/inbox/kat-phase9-item3-config-schema.md` — Decision record for Carter + Jun

**Key decisions made:**
1. `removeKnownCwd` is a **no-op** on missing alias (returns same config reference). Carter's command layer does the user-facing "not found" message.
2. `validatePath` is **async** (needs `fs.stat`); all other helpers are sync. Caller pattern: `validatePath()` → `addKnownCwd()` → `saveConfig()`.
3. Path comparison on Windows is **case-insensitive** (`toLowerCase()` both sides) in `getKnownCwdByPath`.
4. Alias regex: `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/`. Reserved set documents `--cwd`, `--model`, `--name` even though the regex already blocks them (they start with `-`).
5. `addKnownCwd` calls `nodePath.resolve(path)` for safety even when caller already passed a normalized path — idempotent and cheap.

**Strict tsconfig notes (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`):**
- Avoided `lastUsedAt: undefined` in object literals (fails `exactOptionalPropertyTypes`). Used `{ alias, path, addedAt }` without the optional field.
- Avoided `arr[i]` index access in `touchKnownCwd`. Used `.map()` with conditional instead.

**Validation results:**
- `npx tsc --noEmit` — clean
- `npm run lint` — zero warnings
- `npx vitest run` — 2 pre-existing failures (Jun's anticipatory T2/T4 tests, not my scope). Config tests 21/21 pass.

---

### Phase 9 README Documentation (2026-05-30T12:18:53-07:00)

**Task:** Document Phase 9 user-facing features in README.md

**Key decisions made:**
1. **Section placement:** New "Using Reach" section inserted after Installation and before Development Workflow (users install first, then need usage guidance).
2. **Removed old Usage section:** Pre-Phase-9 "Usage" section was incomplete and now superseded by comprehensive "Using Reach" section. Net change: +57 lines (new) −39 lines (old) = +18 lines.
3. **Orientation message format:** Used verbatim format from Item 1 Decision 5 (Kat's own decision file), with exact emoji and layout: `📍 Session active`, `━━━━━━━━━━━━━━━━━━`, etc.

**Structure of "Using Reach" section:**
- Telegram Commands (3 subsections: session mgmt, CWD registry, other)
- CLI Commands Pass-Through (short explanation)
- Orientation Message (sample + context)
- Getting Started: CWD Registry Example (3-step practical workflow)
- Platform Note (Windows-only, cross-platform deferred)

**Voice/style match:** Consistent with Phase 8.5 install section — scannable, practical, realistic examples, no marketing. Aaron is primary reader.

**Pattern learned:** Documentation updates for new features should read from locked decision files (not code), focus on structure and voice match, and be lean (most work is thinking, not writing).

---

## Phase 9 Sprint — 2026-05-30

**Sprint shipped.** All 3 Aaron dogfood feedback items addressed:
1. Orientation message + /status command (Item 1, afkMode + handlers)
2. Slash pass-through via isBotCommand allowlist (Item 2, Carter)
3. /cwd registry + /new --cwd flag (Item 3, config schema + commands)

**Suite:** 720 passed / 4 skipped / 1 todo. +150 net tests.

**Known Phase 10 follow-up:** Cross-platform path detection in /new --cwd (Unix `/` startsWith check deferred).

---

## Phase 9 Review Wave — Security Fixes (2026-05-30)

**Branch:** `user/aaron/phase9`

### I10 — Sensitive-directory warning in `validatePath` (`knownCwds.ts`)

**Extended return type:** `{ ok: true; normalized: string; warning?: string }`. Callers surface the warning to the user; the entry is still added (warn, not block — Aaron's explicit decision).

**Symlink/junction pattern:** `fs.lstat` → `isSymbolicLink()` → if true, `fs.realpath()` to get actual target. Sensitive-prefix check runs on BOTH the normalized string path AND the realpath. If only the realpath triggers → append `(resolved through junction)` to the warning. lstat/realpath failures are non-critical and silently fall through.

**`exactOptionalPropertyTypes` discipline:** Return `{ ok: true, normalized, warning }` vs `{ ok: true, normalized }` as separate branches — never `warning: undefined` in the object literal. Same pattern Kat learned in Phase 9 Item 3.

**F-11 dead code removal:** `RESERVED_ALIASES` set was unreachable (ALIAS_REGEX already blocks all `-`-starting strings). Moved the explanation into the ALIAS_REGEX JSDoc instead of keeping a dead Set. Pattern: when a regex makes a runtime check impossible, remove the check and document the invariant in the regex comment.

**100-entry cap:** Placed BEFORE the duplicate-alias check in `addKnownCwd`. Ordering matters: the cap is a hard limit, so it should fail fast before any alias comparison work.

### I11 — Secret redaction (`redactSecrets.ts`)

**New module:** `src/bot/redactSecrets.ts` → `redactSecrets(text: string): string`. Daemon-side, Telegram-facing. Extension stays a pure cache.

**Pattern order discipline:** Keyword-adjacent (most specific, preserves context) → high-entropy bare (40+ chars, aggressive) → URL creds (structural). Running keyword pattern first means the value group is replaced with `[REDACTED]` before the high-entropy pass sees it — avoids double-matching the same characters in a different pattern.

**`no-useless-escape` lint hit:** `[A-Za-z0-9_\-]` in a character class → `\-` is a useless escape (hyphen at end of character class is literal). Fix: remove the backslash. Always check character-class escaping when writing regexes in TypeScript for ESLint environments.

**Regex replacement with captured separator:** Pattern 1 captures `(keyword)(sep)(value)`. Using `(_match, keyword, sep) => \`${keyword}${sep}[REDACTED]\`` preserves the separator (`: `, `= `, ` `, etc.) in the redacted output, keeping the message readable.

### F-13 — Safe `since.slice`

`(this.mode.since?.slice(11, 16) ?? '??:??') + ' UTC'` — the optional chain on `?.slice` handles both `undefined` and strings shorter than 11 chars, both of which would silently return wrong values with the old conditional form.

### F-15 — orientationSent mutation comment

The mutation `binding.orientationSent = true` is intentional — `binding` is a live reference in `sessionTopics`. Brief comment added so the next reader doesn't refactor it into immutable form and break the AFK cycle guard.

### F-16 — Drift-proof citations

Replacing `handlers.ts:53` with `handlers.ts — bot.command('new', ...)` (symbol-only). Line numbers drift on every refactor; symbol-name references remain stable. Apply this pattern to all cross-file citations in header comments.

