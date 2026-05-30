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
