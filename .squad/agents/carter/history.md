# Carter — History (PR #10 squash-merged 2026-06-06, commit 692e770)
# Carter — History (Summarized 2026-05-30 → Phase 9 complete)
# Carter — History (Summarized 2026-05-28 → Phase 8.5 complete 2026-05-30)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Code Specialist)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, install orchestration, flag parsing, command routing
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, named-pipe bridge, **install orchestration** (Phase 8.5)
- **Joined:** 2026-04-12

## Current Status

**PR #10 Cycle 16 shipped (2026-06-06 — FINAL CYCLE):** T1 — Investigated `BOT_COMMAND_NAMES` alias in `src/bot/commands.ts:36`. Grep of entire repo (`src/` + `tests/`) found zero live references outside the definition; the `.squad/decisions.md` note "alias kept for isBotCommand.test.ts" was itself stale — that test imports only `isBotCommand` and `BOT_COMMANDS`. No hardcoded command-name lists found that should be consuming it. Case (a): genuinely dead. Deleted the export. T2 — Rewrote stale "RED tests (awaiting Carter) / EXISTING TEST CONFLICT" file header in `tests/bot/handlers.slashGuard.test.ts` to describe present reality (guard is live, handlers.test.ts already updated). T3 — Removed 5 inline "RED until Carter:" body comments and stale section-heading suffix from same file; replaced stale conflict note with factual record that handlers.test.ts was updated in this PR. Extra: applied identical cleanup to `tests/relay/afkMode.slashGuard.test.ts` (same TDD scaffold generation — file header + 5 inline comments + section heading) and `tests/bot/isBotCommand.test.ts` (anticipatory header + "RED until Carter lands the regex change" + "(anticipatory)" describe label). tsc clean, lint zero warnings. Tests: 851/851 (no change). Decision in `.squad/decisions/inbox/carter-pr10-cycle16.md`.

 T1 — `src/install/index.ts` bot token prompt echoed raw token to terminal (shoulder-surfing/screen-recording risk). Added `promptSecret()` helper using `_writeToOutput` blank-masking idiom — same pattern already established in `src/service/install.ts:promptPassword()`. Used for `TELEGRAM_BOT_TOKEN` prompt only; `TELEGRAM_ALLOWED_USER_IDS` prompt is non-secret and keeps `promptLine`. Non-TTY handled by the existing wizard gate (exits before reaching any prompt). Sibling audit: `uninstall.ts` has no prompts; `service/install.ts` already masked; no token echo-back in post-capture log. Tests: 849→851 (+2: IX18 captures token correctly with masking active, IX19 verifies no `_writeToOutput` leak to subsequent non-secret prompt via `capturedWriteFns` mock instrumentation). Decisions in `.squad/decisions/inbox/carter-pr10-cycle15.md`.

 T2 (DO FIRST, connectivity-breaking) — `getAuthFilePath()` in `extension.mjs` was reading `%LOCALAPPDATA%\reach\bridge-auth.json` while the daemon writes to `~/.reach/bridge-auth.json` (via `getReachDataDir()` unified in Cycle 3). Extension never connected. Fix: rewrote `extension.mjs getAuthFilePath()` to mirror `getReachDataDir()` exactly (`REACH_DATA_DIR` env override → `path.resolve(override.trim())`, fallback `path.join(homedir(), '.reach')`). Added `resolve` import. ARCHITECTURAL NOTE: path-resolution logic is now duplicated across two runtime boundaries (compiled TS daemon vs standalone .mjs extension); both files carry a LOCKSTEP comment. Future changes to `getReachDataDir()` must be manually mirrored in `extension.mjs`. Also fixed broken N2 test stubs (`LOCALAPPDATA` → `REACH_DATA_DIR`) and added 4 N3 path-contract tests. T1 — `streamSdkResponse()` closures read global `pipeSocket` at execution time; reconnect mid-stream could write old-stream frames to new connection. Fix: declared `let socket = null` before outer try, assigned `socket = pipeSocket` after `await gate`, guarded `enqueueFrame` and done/error frames with `socket !== pipeSocket || socket.destroyed` stale-check. T1 streaming path not unit-testable from current harness (sdkSession coupling); documented in decisions. Tests: 845→849 (+4). tsc clean, lint zero warnings. Decision rationale in `.squad/decisions/inbox/carter-pr10-cycle14.md`.

 T1/T2 — replaced `ghp_`-prefixed token fixtures in `tests/bot/redactSecrets.test.ts` (unquoted + quoted ENV-assignment tests) with `FAKE_GH_TOKEN = 'not-a-real-token-0000'`; ENV pass doesn't care about token shape, and the `-` char makes it unambiguously fake (won't trip GitHub secret scanning). T3 — restructured the AWS-secret charset test from `AWS_SECRET_ACCESS_KEY=<value>` to a bare 42-char value `FAKE+Xm3z9pQr/vNsLwD7hYc+E4aOjZtFu1Ii/8bGn` that only `HIGH_ENTROPY_PATTERN` can redact; added `toBe('[REDACTED]')` companion assertion; deliberately avoids keyword words to prevent `KEYWORD_PATTERN` from firing first. If the cycle-8 charset regressed to exclude `/` and `+`, all fragments would be ≤12 chars and the test fails. Tests: 845→845 (unchanged — all edits to existing fixtures). tsc clean, lint zero warnings. Decision rationale in `.squad/decisions/inbox/carter-pr10-cycle13.md`.

**PR #10 Cycle 12 shipped (2026-06-05):** T1 — added `registry.json` to `wipeLocalData()` marker list in `src/install/uninstall.ts`; full audit of `<dataDir>/` state files confirmed it was the only missing marker. UN14+UN15 tests added (registry-only dir allows wipe; unrelated-file dir refuses). T2 — replaced `sessionParts.length > 1` with unified `/\s/.test(sessionName)` in `parseNewFlags()`; quoted names like `"my session"` now reject with same error as unquoted multi-word. 5 new tests added. Tests: 838→843 (+5). tsc clean, lint zero warnings. Decision rationale in `.squad/decisions/inbox/carter-pr10-cycle12.md`.

**PR #10 Cycle 11 shipped (2026-06-05):** T1 — guarded `relativeTime()` in `src/bot/cwdCommand.ts` against NaN (invalid ISO string → `'unknown'`) and future timestamps (clock skew → clamp diffMs to 0 → `'just now'`). Added 4 tests: invalid timestamp, future timestamp, exactly-now boundary, 2d-ago regression. Tests: 834→838 (+4). tsc clean, lint zero warnings. Decision rationale in `.squad/decisions/inbox/carter-pr10-cycle11.md`.

**PR #10 Cycle 10 shipped (2026-06-05):** T1 — replaced argv[1]-only save/restore in `isDirectRun.test.ts` with full-array `slice()` snapshot + reference restore. IDR5 uses `splice(1)` which mutates array length; the cycle-6 pattern didn't undo that. Full-array restore is strictly correct and no more complex.

**PR #10 Cycle 9 shipped (2026-06-05):** T1 — partial legacy migration retry (Option B: removed early-return on newRoot-exists, per-dir check now handles re-runs after partial failure, MIG8 test added). T2 — excerpt truncation off-by-one corrected (`slice(0, MAX_EXCERPT_LENGTH - 1) + '…'` = 500 chars, length-assertion added to C8 test).

**Test baseline:** 838 passed / 4 skipped / 1 todo. tsc clean, lint zero warnings.
**Phase 8.5 COMPLETE.** Install story shipped 2026-05-30 (copyExtension + orchestrator + uninstaller + dev junction). 570 tests green (537 existing + 33 new). Bridge code stable. Ready for Aaron dogfood re-verification of /afk.

**Test baseline:** 570 passed / 4 skipped / 0 failed. tsc clean, lint zero warnings.

**Phase 8 COMPLETE.** Phase 8 P1 sprint shipped 2026-05-27 (A7 drift coverage + integration harness). Watch sweep complete 2026-05-28 (no bridge/relay changes needed by F4 refactor or A6-6 fleet validation). Bridge code stable and ready for next phase or ship-to-pr.

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

**PR #10 Cycle 2 Patterns:**

- **process.exit in step functions breaks idempotency:** Each step in an install/uninstall orchestrator should return a result type (`{ ok, reason }`) instead of calling `process.exit`. The orchestrator collects all results and exits only at the end. Service uninstallers that call `process.exit` internally are an exception — that's an architectural constraint at the service boundary.
- **Extract shared isDirectRun helper:** Three files had the same `process.argv[1] === fileURLToPath(import.meta.url)` bug. Shared helper in `src/install/isDirectRun.ts` + `path.resolve()` on argv[1] fixes relative-path npm script case uniformly.
- **readdirSync not mocked in uninstall tests:** `uninstall.test.ts` mocks only `existsSync`/`rmSync` — `readdirSync` falls through to real fs and throws on mock paths. The existing catch block in `wipeLocalData` handles this; tests relied on it implicitly. Don't add readdirSync to the mock without understanding why the test still passes.
---

## PR #10 Cycle 3 — Patterns (continued)

- **readdirSync not mocked in uninstall tests:** `uninstall.test.ts` mocks only `existsSync`/`rmSync` — `readdirSync` falls through to real fs and throws on mock paths. The existing catch block in `wipeLocalData` handles this; tests relied on it implicitly. Don't add readdirSync to the mock without understanding why the test still passes.
- **Windows isDirectRun case-sensitivity:** Both `fileURLToPath(import.meta.url)` and `path.resolve(process.argv[1])` use the same Node.js filesystem view. No case-fold needed in practice. If a flake appears, add `.toLowerCase()` guard inside the helper only on `process.platform === 'win32'`.

---

## PR #10 Cycle 5 — Fail-closed wipe + error logging

### Thread 1 — `src/install/uninstall.ts` `wipeLocalData()` fail-closed

The empty `catch` in the marker-file inspection block was removed. If `readdirSync` throws for any reason (EPERM, ENOENT on a misconfigured `REACH_DATA_DIR`, etc.), `wipeLocalData` now returns `{ ok: false, reason: "Refusing to wipe ...: cannot inspect directory (...)" }`. The orchestrator collects the step result and exits non-zero with the message visible to the user. `rmSync` is never reached.

**Key test lesson:** Adding fail-closed behavior to `readdirSync` required adding a `readdirSync` mock to the test's fs mock block. The old empty catch silently covered all wipe=true tests that exercised real paths — those tests would have broken once the catch became a hard fail. Always check whether adding error handling to a try-catch changes how existing tests flow through the formerly-swallowed path.

### Thread 2 — `src/service/install.ts` error logging

Both the `uninstall()` CLI shim (fire-and-forget) and the `main()` uninstall branch now log `[reach] Service uninstall failed: <msg>` before `process.exit(1)`.

**`mockImplementationOnce` pattern for fire-and-forget testing:** When testing a `void`-returning shim whose internal promise chain calls `process.exit`, use `mockImplementationOnce` (not `mockImplementation`) for the non-throwing override. `mockImplementation` is permanent until the next call to it and leaks past `vi.clearAllMocks()` into subsequent tests — I burned a red-phase run discovering this. `mockImplementationOnce` restores the prior implementation automatically after one call, keeping isolation clean.

### Silent-catch audit (install/service domain)

Only one other silent-catch found in the install/service domain: `src/config/migrate.ts:113` — empty legacy dir cosmetic cleanup after a successful migration copy. Provably non-fatal (dir is empty, migration has already succeeded). Left as-is.

**Test baseline after cycle 5:** 816 passed / 4 skipped / 1 todo (+3 new tests: UN12 in `uninstall.test.ts`, SH1 + M-U1 in `install.test.ts`).

---

## PR #10 Cycle 6 — Quote preservation, orientation race, log prefix, test leak

### Cluster 1 (T3/T4/T5/T6) — `src/bot/redactSecrets.ts` quote-preservation bug

Both KEYWORD_PATTERN and ENV_ASSIGNMENT_PATTERN had a non-capturing `['"]?` after the value. The replacement only re-emitted groups 1–2, silently discarding the closing quote. JSON like `token="abc"` became `token="[REDACTED]` (broken close-quote). Fix: made the trailing `['"]?` a named capture group `(["']?)` and appended it in both replacement callbacks.

**Regex rationale:** Used independent `(["']?)` (not a backref to the opening quote group) to preserve the conservative bias rule — false negatives (missed secrets) are worse than false positives. A mismatched-quote input like `token="secret'` still gets redacted; the trailing char is re-emitted as-is.

**Test:** 5 new cases in `tests/bot/redactSecrets.test.ts` (C6-1 through C6-5): double/single/no-quote keyword, double-quote ENV assignment, mismatched-quote.

### T1 — `src/bot/afkMode.ts` orientation send race

`sendOrientationMessage` set `binding.orientationSent = true` after `await safeSendMessage(...)`. If two `activate()` callers both passed the `!binding.orientationSent` guard before either entered the method, both would send. Fix (Option A): move the flag assignment to BEFORE the await. `safeSendMessage` already swallows errors so no rollback needed — a persistent failure shouldn't cause spam.

**Test:** `tests/bot/afkMode.orientationRace.test.ts` — OR1 demonstrates the flag-first guard; OR2 verifies flag stays true when the send throws.

### T2 — `src/service/install.ts` double `[reach]` prefix

The timeout error `new Error('[reach] Service uninstall timed out ...')` was caught by callers that prepend `[reach] Service uninstall failed: ${msg}`, producing `[reach] Service uninstall failed: [reach] ...`. Stripped the prefix from the internal Error message. Audit found this was the only `new Error('[reach]...')` in the file — all other `[reach]` usages are in `console.*` calls (correct placement).

**Test:** SU4 asserts `err.message` has no `[reach]`; SU5 asserts call-site format has exactly one `[reach]`.

### T7 — `tests/install/isDirectRun.test.ts` argv[1] restore leak

`beforeEach` saved `process.argv[1] ?? ''`, so when argv[1] was originally absent (length 1 array), `afterEach` restored it as `''` — "empty" and "absent" argv[1] are not equivalent. Fixed: save as `string | undefined`, restore by deleting the element when originally absent. Added IDR5 test for the `length === 1` branch.

**Test baseline after cycle 6:** 826 passed / 4 skipped / 1 todo (+10 new: C6-1–C6-5 redactSecrets, OR1–OR2 orientationRace, SU4–SU5 install, IDR5 isDirectRun).

---

## PR #10 Cycle 7 — win32 platform gate + dotenv in install entry points

### T1 — `src/config/migrate.ts` win32 gate

`migrateLegacyDataDir()` only migrates Windows legacy paths (`%APPDATA%\reach`,
`%LOCALAPPDATA%\reach`). Copilot review suggested adding `~/.config/reach` migration
for non-Windows, but this was based on a false premise — pre-Cycle 3 code used
`process.env.APPDATA` (Windows only) and there has never been a Unix Reach install.
Fix: explicit `if (process.platform !== 'win32') return;` at top of function, with
a comment warning future contributors not to add Unix migration paths since no legacy
state ever existed there.

**Platform gate position:** Before `migrationAttempted` flag — non-Windows returns
before setting the flag. Semantically correct since the flag is only meaningful for
Windows execution. No double-call issues on any platform.

### T2 — `src/install/uninstall.ts` and `src/install/index.ts`: dotenv loading

Both install entry points now have `import 'dotenv/config'` as their first import.
Without it, `getReachDataDir()` ignores `REACH_DATA_DIR` set only in `.env`, causing
`--wipe` and `migrateLegacyDataDir()` to target `~/.reach` instead of the user's
custom data dir.

**Audit result for sibling entry points:**
- `index.ts` (npm run init): FIXED — calls `migrateLegacyDataDir()` → `getReachDataDir()`
- `uninstall.ts` (npm run uninstall): FIXED — calls `getReachDataDir()` in wipeLocalData
- `copyExtension.ts` (npm run install:extension): CLEAN — only uses `APPDATA` (system var) and `NODE_ENV` (CLI var), never calls `getReachDataDir()`

**Test pattern for entry-point dotenv mocks:** When adding `import 'dotenv/config'` to
a module, also add `vi.mock('dotenv/config', () => ({}))` to its test file. Without this,
dotenv runs at test startup and attempts to read the real `.env` from cwd. This won't
break tests on a machine with a clean `.env` (dotenv doesn't override existing process.env),
but it's noisy and order-dependent. Always add the mock.

**Test baseline after cycle 7:** 828 passed / 4 skipped / 1 todo (+2 new: MIG7 migrate, UN13 uninstall).

---

## PR #10 Cycle 8 — redactSecrets charset gap + defensive excerpt truncation

### T1 — `src/bot/redactSecrets.ts` HIGH_ENTROPY_PATTERN charset

Added `.` and `=` to HIGH_ENTROPY_PATTERN charset: `[A-Za-z0-9_\-/+.=]{39,}`.

- **Why:** JWT-shaped tokens (three `.`-separated base64url segments) and standard base64 strings with `=`/`==` padding were not matched by the bare-entropy pattern, creating false negatives.
- **False-positive analysis:** Long prose URLs are not at risk — `https:` breaks at `:` which is not in the charset. Path segments with `/` are in the charset but realistic paths stay under 39 chars. The only realistic new false positive class would be a URL with a 39+ char unbroken path component — pathological and consistent with the module's conservative bias.
- **Tests added:** C8-1 (JWT header.payload.sig redacted), C8-2 (base64 with `==` padding redacted).

### T2 — `src/bot/afkMode.ts` defensive excerpt truncation

Added `MAX_EXCERPT_LENGTH = 500` module constant at top of `afkMode.ts`. Applied truncation in the `afk.request` handler before `lastKnownExcerpts.set()`. Excerpts > 500 chars are sliced to 500 chars + `…`.

- **Constant location:** `afkMode.ts` module constant (not imported from `protocol.ts`). Protocol file only has a JSDoc comment on the field — no numeric constant exists there. Adding a behavioral constant to a type-only file would mix concerns.
- **Tests added:** C8 truncation block in `afkMode.staleExcerpt.test.ts` — 600/500/499 char cases. Used `'word '.repeat(n)` strings (space-separated) to avoid HIGH_ENTROPY_PATTERN redacting the test values before display assertions.

**Test baseline after cycle 8:** 833 passed / 4 skipped / 1 todo (+5 new: C8-1, C8-2 redactSecrets, C8 × 3 staleExcerpt).



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

---

## PR #10 Cycle 3 Fix Wave (2026-05-31)

**Trigger:** Four Copilot review threads on PR #10. T2 was a BLOCKING regression.

### T2 - Service Uninstall Composability

Extracted `uninstallService(): Promise<void>` from `src/service/install.ts`. Wraps node-windows event-emitter in a Promise with settled boolean guard (prevents double-fire), 60-second timeout rejection, and clearTimeout cleanup. `runUninstall()` promoted to async; service step is a tracked StepResult. Old `uninstall()` kept as a backward-compat CLI shim.

Key learning: node-windows event-emitter patterns need the same settled/timeout/cleanup treatment as the extension.mjs SDK streaming fix. Pattern is reusable across all node-windows wrappers.

### T6 - noble six/ to noble-six/ Consolidation

Physical move via git rm + copy. Merged two history.md files: used the noble six/ version (comprehensive, Phases 6-9) as base, inserted the Phase 9 Sprint breakdown block from noble-six/ (unique KB and Decision Consolidation sections). Streaming-fix section was duplicated - kept one copy. Charter inbox path updated. team.md roster updated.

### T7 - isBotCommand test header comment

Single-line update: replaced stale pre-cycle-1 contract text with accurate post-fix description.

### T8 - TELEGRAM_ALLOWED_USER_IDS wizard validation

Added 3-attempt retry loop before skip-with-confirmation fallback. Validation regex `/^[1-9][0-9]*$/` is a strict subset of parseEnv's check (rejects leading zeros that Number() would silently coerce). Normalization: `tokens.join(',')` before write.

Key learning: wizard validation should be at least as strict as the runtime parser - document any intentional tightening (leading zeros) so future maintainers don't loosen it.

### Validation

- tsc --noEmit: green
- eslint: green (0 warnings)
- vitest run: 797 passed / 4 skipped / 1 todo (was 791; +6 new tests)

---

## PR #10 Cycle 3 Second Wave — Storage Unification (2026-05-31)

**Spec:** Noble Six's `.copilot/reach-state-storage-design.md` Option D.  
**Aaron's locked decision:** unify all Reach state under `~/.reach/` with `REACH_DATA_DIR` env override.

### Changes

**`src/config/config.ts` — `getReachDataDir()` rewritten:**
Removed platform switch (`win32` APPDATA vs Unix `.config`). New implementation: `REACH_DATA_DIR` env override (trimmed, empty-string-safe, `path.resolve()`'d) → `path.join(os.homedir(), '.reach')`. Cross-platform from day one. `getConfigPath()` continues to route through `getReachDataDir()` unchanged.

**`src/config/migrate.ts` — new migration helper (Approach A):**
`migrateLegacyDataDir()` is explicit — called from `runInit()` and `main()`. One-shot: module-level flag prevents double-run per process. If `~/.reach/` exists: no-op. Else if `%APPDATA%\reach\` or `%LOCALAPPDATA%\reach\` exist: copy contents, verify all files present, then remove legacy dir. Never deletes legacy until copy is verified. Log lines confirm each migration.

**`src/bridge/pipeAuth.ts` — `getAuthFilePath()` simplified:**
Removed `LOCALAPPDATA` logic entirely. Imports `getReachDataDir()` and returns `getReachDataDir() + '/bridge-auth.json'`. `os` import retained (still used for ACL's `os.userInfo()`). Docstring updated to reference `~/.reach/`.

**`src/install/uninstall.ts` — `wipeLocalData()` simplified:**
`LOCALAPPDATA` env var dependency removed. `wipeLocalData()` now calls `getReachDataDir()` directly. No-wipe hint updated to show `Remove-Item -Recurse -Force ~/.reach`. `UninstallOptions.wipe` docstring updated.

**`src/install/index.ts` + `src/main.ts` — migration call sites:**
`migrateLegacyDataDir()` called at start of both `runInit()` and `main()`.

**`tests/bridge/cloud-review-1.test.ts` — `vi.stubEnv` patched:**
T3/T4/T7 used `vi.stubEnv('LOCALAPPDATA', tempDir)` to redirect `getAuthFilePath()`. Now uses `vi.stubEnv('REACH_DATA_DIR', tempDir)` — same effect, correct surface.

### Key Patterns Learned

- **Real-filesystem tests that use `vi.stubEnv` to redirect paths must stub the env var that the production code actually reads**, not a legacy env var. When `getAuthFilePath()` was updated from `LOCALAPPDATA` to `REACH_DATA_DIR`, the stubs in cloud-review-1.test.ts broke silently (writes went to `~/.reach/` instead of the tempdir, pipeName comparison failed with a stale cached value). Grep for `vi.stubEnv` whenever changing which env var a path resolver reads.
- **`vi.resetModules()` + dynamic import pattern for module-level flags in tests.** The `migrateLegacyDataDir` flag (`migrationAttempted`) is module-level; resetting it between tests requires re-importing the module fresh. Use `vi.resetModules()` in a helper, then `await import('../../src/config/migrate.js')`, and call the freshly-imported function. Each test gets a clean flag.
- **`REACH_DATA_DIR` env override doubles as a test harness.** Setting it in `beforeEach` to a known path eliminates the need to mock `os.homedir()` in uninstall and migration tests. Cleaner than spy on `os.homedir` which requires module-level mock setup.

### Validation

- tsc --noEmit: green
- eslint src --max-warnings 0: green
- vitest run: 809 passed / 4 skipped / 1 todo (was 797; +12 new tests across config.test.ts, migrate.test.ts, uninstall.test.ts)


---

## PR #10 Cycle 4 Fix Wave (2026-06-01)

**Threads:** 3 (Thread 1: uninstallService sync-throw timer leak; Thread 2: hardcoded ~/.reach in no-wipe hint; Thread 3: stale comment). All in `src/service/install.ts` and `src/install/uninstall.ts`.

### Thread 1 — uninstallService sync-throw timer leak

Added try/catch around `svc.uninstall()` in `uninstallService()`. Catch block: `if (!settled) { settled = true; finish(err); }`. The existing `finish()` helper already called `clearTimeout(timer)` before rejecting — no refactoring needed. The `settled` guard ensures no double-resolution if an async event fires after the sync throw.

Added 3 new tests (SU1-SU3) in `tests/service/install.test.ts`. Key learning: SU tests set `mockSvcUninstall.mockImplementation(() => { throw ... })`. The outer `beforeEach` uses `vi.clearAllMocks()` which clears call counts but NOT mock implementations. This caused the throw impl to leak into the `main()` describe tests, triggering an unhandled rejection when the un-awaited `main()` call hit the throwing `uninstallService()`. Fixed by adding `afterEach(() => { mockSvcUninstall.mockReset(); })` inside the SU describe block.

Pattern: when tests in a shared mock context use `mockImplementation` to override behavior, always reset in afterEach if the outer beforeEach only calls `clearAllMocks` (not `resetAllMocks`).

### Thread 2 — hardcoded ~/.reach in no-wipe hint

`reachDir` was already resolved on line 111. Only the `Remove-Item` command line (line 114) was hardcoded. Updated to ` Remove-Item -Recurse -Force "${reachDir}" `. Other `~/.reach` occurrences in src are JSDoc/comments describing the default — left unchanged.

### Thread 3 — stale comment

Updated `src/install/uninstall.ts:100-102` to accurately describe that `uninstallService()` returns a Promise, does NOT call `process.exit()`, and the orchestrator decides the exit code.

### Validation

- tsc --noEmit: green
- eslint src --max-warnings 0: green  
- vitest run: 813 passed / 4 skipped / 1 todo (was 809; +4 new tests: SU1-SU3 in service/install.test.ts + UN11 in install/uninstall.test.ts)
**Note for Carter:** No bridge action required. Plan focuses on daemon/relay validation. Bridge code remains stable.

---

## Phase 8.5 Task 1 (2026-05-29T23:23:02-07:00) — Extension Copy Installer

**Deliverable:** `src/install/copyExtension.ts` + `"install:extension"` npm script.

**What ships:**
- `src/install/copyExtension.ts` — resolves `%APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs`, validates Copilot CLI is installed, creates `reach/` subdir if needed, copies `extension.mjs` unconditionally (idempotent overwrite), logs target path. Exports `copyExtension()` for orchestrator use (Task 2).
- `package.json` — added `"install:extension": "node dist/install/copyExtension.js"` matching the `service:install`/`service:uninstall` dist runner pattern.

**Validation:** `tsc --noEmit` clean, `npm run lint` clean (0 warnings).

## Learnings

- **Runner pattern choice:** Use `node dist/...js` not `node --import tsx/esm src/...ts` for install scripts. All existing service scripts use compiled dist; staying consistent prevents a confusing split. tsx is dev-only.
- **Project root from dist/install/:** `path.resolve(__dirname, '..', '..')` is reliable when the compiled path depth is fixed. No filesystem walk needed (unlike `service/install.ts` which uses a dynamic walk because it was written before the path depth was established).
- **process.exit narrows type:** TypeScript correctly narrows `appData` from `string | undefined` to `string` after `if (!appData) { process.exit(1); }` because `process.exit` returns `never`. No need for non-null assertion downstream.

---

## Phase 8.5 Task 2 (2026-05-29T23:36:06-07:00) — Full Install Orchestrator

**Deliverables:**
- `src/install/copyExtension.ts` — updated: added dev junction mode. `NODE_ENV=development` creates a Windows directory junction (`reach/` → repo root) instead of copying. Uses `existsSync`+`rmSync` pattern (not `lstatSync`) so Jun's test mocks work cleanly. Source-file check moved inside production branch (dev mode skips it — junction provides access without an explicit copy).
- `src/install/index.ts` — new: `runInit()` orchestrator. Banner, TTY-gated config wizard (bot token prompt, chat ID warn-only, allowed-user-IDs prompt with explicit skip), `copyExtension()`, next-step summary print, then `install()` from service/install.ts (which handles its own exit).
- `src/install/uninstall.ts` — implemented (was a stub): `runUninstall({ wipe })`. Removes extension dir (existsSync+rmSync), optionally wipes %LOCALAPPDATA%\reach\, then calls `uninstall()` from service/install.ts. Step ordering matters: all sync cleanup before the async service uninstall (which process.exit()s internally).
- `package.json` — added `"init"` and `"uninstall"` scripts (dist runner pattern).

**Test results:** 33/33 install tests green. 570 passed / 4 skipped / 0 failed full suite.

**Validation:** tsc --noEmit clean, npm run lint clean (0 warnings), vitest 570/574.

## Learnings

- **Mock what the tests mock.** When Jun's tests mock `existsSync`/`rmSync` but not `lstatSync`, using `lstatSync` in the implementation silently calls the real filesystem. Use the same fs surface the tests mock. Lesson: read the test file's mock setup before picking implementation strategy for file operations.
- **node-windows events + process.exit = unreachable code after `install()`/`uninstall()`.** Both functions from service/install.ts call `process.exit` in their event handlers. Any code placed after calling them is dead. Structure orchestrators to print all user-visible output BEFORE the hand-off call.
- **Dev mode can skip guards that don't apply.** Moving the source-file `existsSync` check inside the production branch is correct: dev mode doesn't need the file to exist separately (the junction exposes it). This also happens to make the tests cleaner. Both are wins.

---

## Phase 9 Item 2 (2026-05-30) — Slash Command Pass-Through

- **BOT_COMMANDS source-of-truth:** `src/bot/commands.ts`. The authoritative list is
  derived from `bot.command()` registrations in `handlers.ts`: `new` (line 53),
  `list` (line 131), `remove` (line 145), `resume` (line 161), `help` (line 244),
  `pair` (line 259). Both `afkMode.ts` and `handlers.ts` import from `commands.ts`.
  Future maintainers: if you add a BotFather command, add it here too.

- **Pre-existing tests encode old invariants.** T4 in `afk-mode.contract.test.ts`
  and the "ignores command messages" case in `handlers.test.ts` both tested the old
  blanket `/` drop behavior. When a design decision changes, grep for tests that
  assert the old behavior explicitly — they won't fail on type-check or lint, only on
  the test run. Always run `npx vitest run` after any guard change.

- **ADR vs. Phase update semantics.** ADR-11 §2 said `/back` is CLI-only ("not honored
  from Telegram"). Phase 9 pass-through supersedes that for relay re-targeting: `/back`
  now forwards via mirror.input. The core protocol invariant (no `back.confirmed`
  without `back.request`) is still correct — text pass-through doesn't trigger it.
  When Phase supersedes an ADR clause, update the test and document the supersession
  in the decisions file. Don't silently leave contradictory test comments.

- **`ReadonlySet<string>` for shared command sets.** Jun's test contract expected this
  type. Using `export const X: ReadonlySet<string> = new Set([...])` ensures the
  consuming code can't mutate the set and the type flows correctly through imports.

---

## Phase 9 Item 3 (2026-05-30) — /cwd Command Group + /new --cwd Flag

- **General Topic detection is `message_thread_id === undefined`.** In Telegram supergroup
forums, messages in the General Topic have no `message_thread_id`; all session topics
have one. This is the right guard for commands that should only run in the General Topic.

- **Registry already supported cwd.** `ISessionRegistry.register()` had a 5th optional
`cwd?: string` param from a prior phase. No interface changes needed. The key constraint:
when `--cwd` is absent, call with exactly 4 args so existing test assertions
(`toHaveBeenCalledWith(42, chatId, name, undefined)`) don't break.

- **Position-independent flag parsing via `.replace(/(^|\s)--flagname\s+(\S+)/g, ...)`.**
This regex correctly handles flags before name, after name, and in any order. The
`(^|\s)` group captures either start-of-string or a space separator; replacing the full
match with `''` cleanly removes the flag+value without fusing adjacent words because
the leading space (when present) is included in the match. Always normalize with
`.replace(/\s{2,}/g, ' ').trim()` afterward.

- **Dangling flag detection after extraction.** After extracting known flags, a dangling
`--model` or `--cwd` (present but no value) remains in the `name` string. Detect with
`/(^|\s)--flagname($|\s)/` — the `$` matches end-of-string, the `\s` matches a following
space. This preserves the `expect.stringContaining('model value')` assertion from the
existing test suite without special-casing the old regex.

- **`args.slice(2).join(' ')` for path args with spaces.** Splitting user input on `\s+`
fragments Windows paths containing spaces (e.g., `C:\my projects\repo`). Rejoining from
index 2 onward recovers the full path. Always use this pattern for positional path args
in Telegram command handlers.

- **`relativeTime()` is a private handler-module helper.** Not exported because it's only
used by the `/cwd list` reply formatter. If tests need to cover it directly, extract to
`src/bot/formatters.ts` and export — note the move in the decisions file so Jun can
update imports.

- **720 tests green after Item 3** (637 baseline + 67 Jun Item 2 anticipatory + 16 Jun Item 3
anticipatory). Test count is a reliable coordination signal: if it doesn't jump when you
land a feature, check whether Jun's anticipatory tests are failing silently.

---

## Phase 9 Sprint — 2026-05-30

**Sprint shipped.** All 3 Aaron dogfood feedback items addressed:
1. Orientation message + /status command (Kat, afkMode + handlers)
2. Slash pass-through via isBotCommand allowlist (Carter Items 2)
3. /cwd registry + /new --cwd flag (Carter Items 3 + Kat config schema)

**Suite:** 720 passed / 4 skipped / 1 todo. +150 net tests.

**Known Phase 10 follow-up:** Cross-platform path detection in /new --cwd (Unix `/` startsWith check deferred).

