# Carter — History (Summarized 2026-05-28 → Phase 8.5 complete 2026-05-30)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, named-pipe bridge, **install orchestration** (Phase 8.5)
- **Joined:** 2026-04-12

## Current Status

**Phase 8.5 COMPLETE.** Install story shipped 2026-05-30 (copyExtension + orchestrator + uninstaller + dev junction). 570 tests green (537 existing + 33 new). Bridge code stable. Ready for Aaron dogfood re-verification of /afk.

**Test baseline:** 570 passed / 4 skipped / 0 failed. tsc clean, lint zero warnings.

**Phase 8 COMPLETE.** Phase 8 P1 sprint shipped 2026-05-27 (A7 drift coverage + integration harness). Watch sweep complete 2026-05-28 (no bridge/relay changes needed by F4 refactor or A6-6 fleet validation). Bridge code stable and ready for next phase or ship-to-pr.

---

## Phases 1–6 Summary

Full Phase 1–6 documentation (MarkdownV2, message splitting, relay plumbing, session discovery, bridge implementation, dogfooding spike, permission prompting investigation, /afk protocol analysis) archived in history-archive.md.

**Key accomplishment:** Relay with 800ms throttle, MarkdownV2 fallback, split-chunk logic, idle eviction. Named-pipe bridge with heartbeat, JSON-Lines protocol. 358+ tests passing. Production-ready.

---

## Phase 7 (2026-05-24T23:19:14-07:00) — Pipe Types + Extension Commands

- Protocol union owner: src/bridge/extensionBridge.ts (InboundMessage / OutboundMessage)
- Added ADR-11 pipe surface: fk.request, ack.request, fk.activated, ack.confirmed, mode.changed, mirror.input, elay.command
- Amended session.registered with optional mode + 	opicId
- New BridgeEmitter channels: fk.request(sessionId) and ack.request(sessionId)
- xtension.mjs registers /afk and /back slash commands; handles mirror.input by logging and feeding through SDK stream path
- Validation: tsc clean, vitest green, lint clean

**Orchestration log:** .squad/orchestration-log/2026-05-25T06-19-14Z-carter-4.md

---

## Phase 7 Orchestration Complete (2026-05-25T06:19:14Z)

**Outcome:** Protocol pipe types (ADR-11 §4) + extension.mjs slash command infrastructure complete. All suite green. 

**Decisions merged:** carter-phase7-pipe-types.md — protocol locations, event channels, scope boundaries.

**Handoff:** Kat integration (daemon-side AFK state machine consumes BridgeEmitter events) + Jun testing (contract tests verify round-trip message flow).

---

## Phase 8 P1 Sprint (2026-05-27T23:48:20Z) — Integration & Configuration Guards

**Deliverable:** A7 — Extended 	ests/bridge/extension-protocol-drift.test.ts with 30 new assertions covering all 6 inbound message types (hello, pong, stream, stream.error, afk.request, back.request). All interfaces verified against ADR-8/ADR-10/ADR-11 specs. **No drift found.**

**Test additions:**
- Union-coverage group (3 tests): Discriminant parsing + union members
- hello/RegisterMessage group (6 tests): Fields, required/optional, exact field-name guard
- pong/PongMessage group (4 tests)
- stream/StreamMessage group (6 tests): Chunk and final variants
- stream.error/StreamErrorMessage group (5 tests)
- afk.request/AfkRequestMessage group (3 tests): ADR-11 §4.1
- back.request/BackRequestMessage group (3 tests): ADR-11 §4.3

**Discoveries:**
- stream mid-stream chunks written directly via pipeSocket.write(JSON.stringify(...)) (performance hot-path)
- 4 pre-existing test failures in main-composition.test.ts are A8/N3 work (verified with git stash)
- No ADR drift; all interfaces match spec exactly

**Validation:** 515 passed / 4 skipped / 0 failed (before fleet test). tsc clean, lint clean.

---

## Phase 8 Watch Sweep (2026-05-28T17:00:30Z) — COMPLETE

**Status:** No bridge or relay changes triggered by watch sweep. F4 soft refactor (stream router extraction) and A6-6 fleet validation both orthogonal to bridge code. Bridge remains stable.

**Notes:**
- F4: Stream routing extracted to new module fkStreamRouter.ts in bot layer. Bridge unaffected.
- A6-6: Fleet compensation burst validated at N=20 with/without 429 retries. Bridge event/relay messaging unchanged.
- All P2 watches (A2/F8 auth-related, F5/A10-4 future phases) dormant.

**Phase 8 closure:** All items delivered and merged into decisions.md. Ready for ship-to-pr.

---

## Phase 8 Dogfood Plan (2026-05-29T21:53:17-07:00)

Noble Six synthesized comprehensive dogfood plan for Phase 8 validation (340 lines, 16 scenarios). Plan validates:
- Permission prompting edge cases (ADR-9, no-timeout guarantee)
- AFK mode fleet binding & stream routing (ADR-11 + F4 refactor)
- Multi-chunk stream truncation (Cycle 3 fixes)
- Config guard for deny-all protection (N2 guard)

**Staging:** Dogfood plan merged to decisions.md. Awaiting Aaron's execution.

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

## Learnings (2026-05-30T14:08:11-07:00)

- **`exactOptionalPropertyTypes` changes return-shape ergonomics.** For optional fields like `model?: string`, returning `{ model: undefined }` fails type-check; build objects conditionally (`...(model !== undefined && { model })`).
- **Structured extraction helps contain handler growth.** Pulling `/cwd` into `handleCwdCommand` made warning surfacing and logging additions straightforward without destabilizing the relay path.
- **Extension stream correctness needs two gates, not one.** Serialization (`streamQueue`) prevents cross-wired listeners; drain-aware writes (`writeFrame` + `writeQueue`) protects the pipe under backpressure. Either one alone is incomplete.
