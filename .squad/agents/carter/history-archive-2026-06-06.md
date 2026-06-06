# carter — Full History Archive (Phases through 9)

Archived on 2026-06-06 when history.md exceeded 15360 bytes. Phase 1 is in current history.md.

---


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

---

## Learnings: P1 Core Rewire — Channel Abstraction (2026-06-06)

**Task:** Phase 1 of Teams generalization: refactor EXISTING Telegram path onto the ChannelPort contract with zero behavior change. Covers P1-2 (SessionEntry string IDs), P1-3 (relay on ChannelPort), P1-4 (TelegramChannel adapter), P1-6 (startup wiring).

### What Changed

**SessionEntry migration (P1-2):**
- `topicId: number` → `threadId: string`, `chatId: number` → `channelId: string`, `lastTopicId?: number` → `lastTopicId?: string` in `src/types.ts`.
- Back-compat on load: `src/sessions/registry.ts` `coerceId()` reads `raw['threadId'] ?? raw['topicId']` and `raw['channelId'] ?? raw['chatId']`, converting numeric JSON values to strings. Existing installs transparently migrate on next write.
- Telegram numeric IDs converted to strings at the adapter boundary (`String(ctx.message.message_thread_id)`); numeric form restored for Telegram API calls (`Number(persisted.lastTopicId)`).

**TelegramChannel adapter (P1-4):**
- `src/channel/telegram/index.ts` — implements `ChannelPort` wrapping grammY Bot. Self-registers via `registerChannel('telegram', factory)` at module scope (side-effect import in main.ts).
- Capabilities: `{ supportsMessageEdit: true, supportsThreadCreation: true, supportsInteractivePrompts: true, supportsStreaming: true, maxMessageLength: 4096 }`.
- Delegates formatting to `markdownV2.ts` and splitting to `messageSplitter.ts` — zero logic rewrite.
- Exposes `editMessageWithMarkdown()` and `sendMessageWithMarkdown()` extras for relay duck-typing.
- `onMessage`/`onCommand` are no-ops — Kat migrates command dispatch in next round.

**Relay rewire (P1-3):**
- `src/relay/relay.ts` now takes `ChannelPort` as first arg; `relay(channelCtx: ChannelContext, text: string)`.
- `rekeySession(fromThreadId: string, toThreadId: string)` replaces the old context-based rekey.
- `safeEditFormatted` / `safeSendFormatted` wrap `editMessage`/`sendMessage` with MarkdownV2 duck-typing for TelegramChannel.
- In-stream throttle edit, F-E fallback edit, and error-path edit all wrapped in try-catch so relay never propagates from editMessage failures.

**Startup wiring (P1-6):**
- `main.ts` imports `./channel/telegram/index.js` for side-effect registration.
- `createChannel(cfg.reachChannel)` creates the port; passed to `registerHandlers()`.
- `cfg.reachChannel` defaults to `process.env.REACH_CHANNEL ?? 'telegram'` (added to `EnvConfig`).

### Relay Behavior Notes
- The relay's 800ms throttle edit (`channel.editMessage`) now fires during streaming but is wrapped in try-catch — failures don't interrupt streaming.
- The "chunk cap" is enforced by `splitMessage` returning ≤25 chunks; the cap check should count follow-up `sendMessage` calls (≤24), not editMessage calls (which are all updates to the same placeholder).

### What Was Left for Kat
1. **Command dispatch via ChannelPort:** All 8 command handlers in `src/bot/handlers.ts` still call `ctx.reply()` directly with Telegram options. `TelegramChannel.onMessage/onCommand` are no-ops. Kat migrates handlers onto `onCommand`/`onMessage` next round.
2. **Formatting polish:** `safeSendFormatted` and `safeEditFormatted` duck-type to TelegramChannel for MarkdownV2. Non-Telegram channels get `formatForTransport()` + plain edit/send. Kat can replace duck-typing with a proper `formatMessage(ctx, text)` method on ChannelPort in the future.
3. **`bot.start()` stays in main.ts:** The `channel.start()` method on TelegramChannel wraps `bot.start()` but isn't called from main.ts yet — main.ts still calls `bot.start(...)` directly. Kat should flip this in the next round to go fully through the port.

### Test Suite
- 849 tests pass (57 files), 4 skipped, 1 todo.
- Updated tests: `relay.test.ts`, `handlers.test.ts`, `handlers.slashGuard.test.ts`, `resume.test.ts`, `idleMonitor.test.ts`, `registry.test.ts`, `registryMocks.ts`, `afkContract.ts`, `sessionRegistry.contract.test.ts`, `sdk-crash-recovery.test.ts`, `relay-with-bridge.test.ts`, `cloud-review-1.test.ts`, `main-composition.test.ts`.
- Mechanical updates: all numeric `topicId/chatId` fixtures → string `threadId/channelId`; `ctx.reply('…')` assertions → `channel.sendMessage(ctx, '…')` for relay-triggered tests.



**Task:** Map the depth of Telegram/grammY coupling in Reach to scope Microsoft Teams generalization. No code changes; read-only inventory only.

**Key Files & Coupling Hotspots:**

1. **Direct grammY imports** (7 files): `src/bot/index.ts`, `handlers.ts`, `relay.ts`, `afkMode.ts`, `afkStreamRouter.ts`, `pairing.ts`, `prompt.ts`.

2. **Telegram-specific coupling** (19+ files reference `message_thread_id`, `parse_mode`, forum topics, chat IDs, user IDs, 4096-char limits, MarkdownV2 escaping).

3. **Message/Session Relay Flow:**
   - **Inbound:** Telegram polling (main.ts:98) → grammY handler → relay.relay(ctx) → extract topicId + userText → factory.resume/create → session.send() → stream chunks
   - **Outbound:** ctx.reply() placeholder → throttled edits (800ms) → splitForTelegram() respecting 4096 limit → MarkdownV2 escape or plain-text fallback → ctx.api.editMessageText() + follow-up ctx.reply() for chunks

4. **Telegram-Specific Constants & Limits:**
   - TELEGRAM_MAX_TEXT = 4096, TELEGRAM_MAX_DISPLAY = 4000, MARKDOWN_ESCAPE_EFFECTIVE_MAX = 2048
   - STREAM_EDIT_THROTTLE_MS = 800, MAX_MIRROR_TEXT_LENGTH = 4096, MAX_RATE_LIMIT_DELAY_MS = 30_000 (capped Telegram retry_after)
   - Smart chunk boundaries: paragraph > line > word > hard cut

5. **Config/Env Surface:**
   - TELEGRAM_BOT_TOKEN (required), TELEGRAM_CHAT_ID (optional, triggers pairing), TELEGRAM_ALLOWED_USER_IDS (optional)
   - config.json: telegramChatId, telegramAllowedUserIds

6. **Abstraction Seams (Ready for Generalization):**
   - ✅ relay/ports.ts (SessionLookup, PermissionPrompter) — relay doesn't know Telegram
   - ✅ escapeMarkdownV2(), splitForTelegram() — pure functions, no platform state
   - ✅ ISessionRegistry interface — contract-driven, implementation-agnostic

7. **Tangled Coupling (Rework Required for Teams):**
   - ❌ Bot handlers (handlers.ts:62-300+) — all 8 commands hardcoded to ctx.reply() with Telegram options
   - ❌ SessionEntry.topicId = Telegram forum topic ID (types.ts, registry.ts) — assumes forum topic concept
   - ❌ MarkdownV2 hardcoding (relay.ts:254, 280) — Teams uses different markdown
   - ❌ AfkModeController (afkMode.ts) — 300+ lines tightly coupled to grammY Bot + Telegram topics + retry_after parsing
   - ❌ Mirror input path (afkMode.ts:161-210) — Telegram-specific rate limiting, user ID extraction, source='telegram' label
   - ❌ Retry-after error handling (afkMode.ts:74-81) — Telegram error shape (error_code, parameters.retry_after)
   - ❌ Command router (handlers.ts + commands.ts) — COMMAND_NAMES shared, but each handler takes grammY Context

**Effort Estimate for Teams Support:**
- High: Bot handlers (8 commands duplication), AFK mode (300+ lines), relay send paths (MarkdownV2 branch)
- Medium: Topic ID abstraction (SessionEntry.topicId → channelId), error handling
- Low: Message splitter (already generic), session registry (swappable key)

**Full inventory:** `.squad/decisions/inbox/carter-teams-channel-inventory.md` (Part 1-6 breakdown with file:line citations, flow diagrams, data shape assumptions, abstraction evaluation).

