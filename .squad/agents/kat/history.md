# Kat — History (Summarized 2026-05-30 → Phase 9 complete)

---

**CROSS-AGENT NOTE (2026-06-06):** Noble Six's ADR-DRAFT for comms-channel abstraction (Teams support) is now in decisions.md under "Proposed / Pending Approval." Phase 1 task breakdown (P1-4 and P1-5) routes work to Kat for TelegramChannel adapter creation and handler refactoring. Also P2-4 (Adaptive Card formatting for Teams). Awaiting Aaron's approval gate before Phase 1 implementation.

---

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


### Phase 10 (Channel Abstraction P1-5): Handler Migration (2026-06-06)

- Command handlers now use `(channelCtx, args)` signature via `channel.onCommand()`.
- `ctx.reply()` replaced by `channel.sendMessage(channelCtx, text)`.
- `message_thread_id` is implicit in `channelCtx` — `TelegramChannel.sendMessage` handles falsy `threadId` by omitting `message_thread_id` (General Topic).
- AFK mirror stays grammY-specific via `setMessageInterceptor()` because it needs `ctx.from?.id` and other Telegram `Context` fields.
- `/status` and `/cwd` use the synthetic-ctx adapter pattern to bridge to legacy grammY-only APIs without widening `ChannelPort`.
- Single Bot instance: `TelegramChannel` owns the bot; `main.ts` casts to get it for `AfkModeController` and prompt registry wiring.
- `ensurePromptRegistry(bot)` stays in `registerHandlers` for the `interactiveDestructive` eager-registration behavioral test.
- Zero-regression outcome: Carter's 849 tests pass through the new seam.
