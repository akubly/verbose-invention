# Carter — History (Summarized 2026-05-30 → Phase 9 complete)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Code Specialist)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, install orchestration, flag parsing, command routing
- **Joined:** 2026-04-12

## Current Status

**Phase 9 COMPLETE.** Cycle 1 fix wave shipped (1d9955b): I1+I2 streaming queue, I3+I4 quote-aware parser, I6 shared registry, I8+I9 /cwd extraction, B1+B3 minors. Cycle 2 cleanup shipped (07358fe): C2-B1 drain race fix, C2-I1 AWS key redaction patterns. Cycle 3 structural cleanup in flight (A4+A5). Branch user/aaron/phase9, 783 tests passing.

**Test baseline:** 783 passed / 4 skipped / 1 todo. tsc clean, lint zero warnings.

---

## Major Work Summary

### Phase 9 Cycle 1 — Big Fix Wave

**I1+I2 — Streaming Serialization Queue:** Per-session queue in `extension.mjs` (Noble Six Option A). Drain-aware `writeFrame()` + per-request `writeQueue` promise chaining. Prevents concurrent stream cross-wiring and enforces backpressure compliance.

**I3+I4 — Quote-Aware Flag Parser:** `parseNewFlags` tokenizer in `src/bot/newFlagParser.ts`. Single/double quote support. Backslash literal (Windows UNC path safety, not escape sequences). Last-value-wins for repeated flags.

**I6 — Shared Command Registry:** `BOT_COMMAND_NAMES` alias export in `src/bot/commands.ts`. Startup drift check prevents hard-coded handler registrations from diverging. Fast-fails at boot.

**I8+I9 — /cwd Extraction:** `handleCwdCommand(ctx, opts)` in `src/bot/cwdCommand.ts`. Structured logging (info/warn/error). Surfaces `validatePath().warning` to user before success reply.

**B1+B3+Minors:** isBotCommand digit fix, lstatSync production-branch check, isDirectRun ESM pattern, .env line endings, uninstall marker.

**Test impact:** 725 → 771 (+46 net).

### Phase 9 Cycle 2 — Surgical Cleanup

**C2-B1 — writeFrame Drain Race:** Resolve-not-reject on socket close. Error responsibility shifted to next frame check. Matches Node.js core stream pattern.

**C2-I1 — AWS Key Leakage:** Added `/` and `+` to HIGH_ENTROPY_PATTERN charset (base64 characters). Extended ENV_ASSIGNMENT_PATTERN to match ACCESS_KEY(?:_ID)?. Docstring corrected "40+" → "39+".

**Escape Consistency:** Removed `\\` → `\` and `\"` → `"` escape sequences from double-quoted tokenizer. Backslash now always literal (symmetric with single quotes, Windows-safe).

**Multi-word Session Name:** Added early check + friendly error hint before parsing.

**ProgramData Prefix:** Added to sensitive-dir list in validatePath.

**JSDoc Additions:** File-level docstrings on cwdCommand.ts and newFlagParser.ts matching redactSecrets.ts standard.

**Test impact:** 771 → 783 (+12 net).

### PR #10 Review — Stale Excerpt Fix

**Bug:** `lastKnownExcerpts` was "update on present, leave on absent". A subsequent
`afk.request` without `lastAssistantExcerpt` (older extension, session just started)
left the stale excerpt from a prior activation in the map. `/status` and orientation
messages would then show outdated context.

**Fix:** `src/bot/afkMode.ts:119-128` — changed the `afk.request` handler to always
reflect the current snapshot: `set` when excerpt is present and non-empty, `delete`
otherwise. Empty-string treated as absent (redaction can produce `''`).

**Consumer check:** `formatOrientationMessage` already guards with `if (rawExcerpt)`
(falsy for `undefined` after delete, and for `''`) — no consumer changes needed.

**Test:** `tests/bot/afkMode.staleExcerpt.test.ts` — 3 cases: with excerpt, omitted
excerpt after prior activation, empty-string excerpt. Uses EventEmitter-backed
TestBridge to fire the real handler with args.

**Test impact:** 783 → 786 (+3 net).

---

## Key Learnings

**Phase 9 Cycle 1 Patterns:**

- **Runner pattern:** Use `node dist/...js` for install scripts. All existing service scripts follow this; breaking it confuses users (tsx is dev-only).
- **Project root from compiled dist:** `path.resolve(__dirname, '..', '..')` is reliable when path depth is fixed. No filesystem walk needed (unlike service/install.ts).
- **Mock what tests mock:** When tests mock `existsSync`/`rmSync` but not `lstatSync`, use the mocked surface. Reading test mocks first informs implementation strategy.
- **process.exit unreachable code:** Service functions (install/uninstall) call process.exit in event handlers. All user output must print BEFORE handoff, not after.
- **Dev mode can skip guards:** dev-mode junction doesn't need file-exists check; moving it inside production branch simplifies tests and semantics.

**Phase 9 Cycle 2 Patterns:**

- **exactOptionalPropertyTypes:** Build objects conditionally with spread (`...(model !== undefined && { model })`) instead of including undefined-valued keys.
- **Extension stream correctness needs two gates:** Serialization (streamQueue) prevents cross-wiring; drain-aware writes (writeFrame + writeQueue) handles backpressure. Neither alone is sufficient.
- **Test file specs are contracts:** Escape-handling test comments documented the actual behavior. Always check test files for behavioral contracts before "improving" implementations.
- **Dangling flag detection:** After extracting known flags, check for `/(^|\s)--flagname($|\s)/` to catch values that weren't provided (both `--model` alone and at end-of-string).

---

## Phase 8.5 — Install Story

**Task 1:** copyExtension.ts + install:extension script  
**Task 2:** Full orchestrator (runInit, config wizard, junction mode, uninstaller)  
**Commit:** Phase 8.5 tasks 1-2 delivered. 570 tests green.

---

## Phase 8 — Bridge Stability

**P1 Sprint:** Extended protocol-drift tests to 30+ assertions (all 6 inbound message types verified vs ADR specs). No drift found.

**Watch Sweep:** F4 refactor (stream router) and A6-6 fleet validation orthogonal to bridge. Bridge remains stable.

---

## Phase 7 — Pipe Types & Extension Commands

Protocol union owner (src/bridge/extensionBridge.ts). ADR-11 pipe surface added. Extension slash command infrastructure. All suite green.

---

## Phase 9 Cycle 3 — Structural Cleanups (A4 + A5)

**A4 — Single source of truth for command registration:**

Exported `COMMAND_NAMES` array + `CommandName` type from `commands.ts`. `BOT_COMMANDS` is now derived (`new Set(COMMAND_NAMES)`) rather than separately constructed. In `handlers.ts`, the 8 `bot.command()` calls were restructured into a `Record<CommandName, (ctx: Context) => Promise<void>>` object literal, then registered in a `for (const name of COMMAND_NAMES)` loop. `REGISTERED_HERE` + the runtime drift check were deleted. TypeScript now enforces handler coverage via the `Record<CommandName, ...>` type — build-time instead of runtime.

Discovered: `bot.command()` in grammY narrows `ctx.match` to `string | undefined`, but the base `Context` type has `match: string | RegExpMatchArray | undefined`. When extracting handlers to a typed object with `(ctx: Context)`, two callsites (`/new` input, `/resume` name) required `(ctx.match as string | undefined)?.trim()` casts. Pattern to remember: `bot.command()` overloads narrow context generics; extracting to plain object loses that narrowing.

**A5 — parseNewFlags discriminated Result type:**

Replaced `ParsedNewFlags` (had optional `error?` field) with `ParseResult<ParsedNewFlagsValue>` discriminated union. `parseNewFlags` now wraps its entire body in try/catch, converting all internal throws to `{ ok: false, error }`. Caller in `/new` handler simplified from try/catch + if-error to a single `if (!parsed.ok)` guard. Test file updated: `.toThrow()` assertions become `ok: false` checks; `result.sessionName` becomes `result.value.sessionName` etc.

Key pattern: when public API mixes `throw` and `return { error? }`, consolidate at the public boundary — internal helpers can keep throwing, the outer function catches and normalizes. This eliminates dual error-handling at every callsite.

---

## Phase 10 Backlog

- Cross-platform path detection in /new --cwd (Unix `/` startsWith check)
- Bot token plaintext echo during wizard (minor Security, deferred)
- .env file permissions hardening (minor Security, deferred)
- newFlagParser single-quote `\'` handling (minor, acceptable)
- redactSecrets over-redaction on very long model names (minor, acceptable per bias)

---

## Phase 9 Cycle 3 Complete (2026-05-31)

A4 + A5 refactors (single command registry, discriminated ParseResult union) shipped in commit 41a584e. Architect's findings addressed. Branch user/aaron/phase9 now 9 commits ahead. Suite stable at 783 tests. Ready for PR. No further review cycles required.
