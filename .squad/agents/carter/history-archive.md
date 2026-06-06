# Carter — Full History Archive (Phases 1–5)

This file archives the complete work history for Phase 5 and earlier. Current active history is in `history.md`.

## Phases 1–5 Accomplishments

### Phase 5 Wave 1: MarkdownV2 Escaping
- Module: `src/relay/markdownV2.ts` (escape-only strategy, no AST parsing)
- Special chars: 18 + backslash; only `\` and `` ` `` inside code
- Code region protection: spans and blocks preserved
- Relay integration: `safeEdit()` fallback chain (MarkdownV2 → plain text)
- Test coverage: 22 new unit tests, all GREEN ✅

### Phase 5 Wave 2: Message Splitting (Telegram 4096-char limit)
- Module: `src/relay/messageSplitter.ts`
- Algorithm: boundary preferences (`\n\n` > `\n` > whitespace > hard cut)
- Code block protection: never split mid-block, re-fence on sub-chunks
- Multi-chunk delivery: first via `safeEdit()`, rest via `ctx.reply()` (100ms delay)
- Two-pass numbering: `[n/total]\n` only when total > 1
- Test coverage: 21 new unit tests, all GREEN ✅

### Phase 5 Persona Review Fixes (11 findings)
- F1: Numbering prefix overflow (two-pass algorithm)
- F4: Escape expansion budget (30% headroom via `effectiveMaxLen`)
- F5: Numbering enabled flag
- F6: MarkdownV2 fallback guard
- F7: Escalated → port injection (relay.ts zero imports from bot/sessions)
- F8: Duplication extraction (`withMarkdownFallback`)
- F9: Chunk failure tracking by index
- F10: 100KB stream cap + 25-chunk DoS guard
- F11: Hard-cut for overlong code lines
- F12: Odd-fence defensive check
- F13: JSDoc on `needsEscaping`

### Phase 5 PR #5 Review Fixes (3 findings)
- F-A: MarkdownV2 budget (EFFECTIVE_MAX = 2048)
- F-D: Chunk cap + maxChunks option
- F-E: First-chunk failure handling

### Package.json Fix
- Entry point: `dist/main.js` (matches TypeScript output from `src/main.ts`)

## Test Coverage & Quality

- **Final Phase 5:** 278 tests pass, 4 intentional placeholder stubs
- **Code quality:** tsc clean, lint clean
- **Status:** Production-ready

## Key Design Patterns

1. **Escape-only strategy** — No Markdown AST parsing; covers 95% of Copilot output
2. **Mid-stream fallback** — Partial output with unclosed fences fails V2 parsing; only final edit uses V2
3. **Boundary semantics** — Preserves reading units (paragraphs > lines > words)
4. **Code safety** — Balanced fences on every chunk; language tags preserved
5. **Rate limiting** — 100ms delay between chunk sends; safe within Telegram ~30 msg/s
6. **Port injection** — Eliminates cross-layer coupling; relay is a pure function of ports
7. **Reserve budget** — MarkdownV2 expansion is ~30% worst-case; reserve upfront, not post-escape

## Learnings

### SDK Introspection Methodology
1. Read `package.json` for version and exports
2. Read `dist/index.d.ts` for public API surface
3. Read `dist/client.d.ts` and `dist/types.d.ts` for detailed types
4. Read `README.md` for documented behavior
5. Read `dist/client.js` (implementation) for undocumented behavior
6. Check the actual filesystem state to validate what the CLI writes

### Architecture Decisions

- **F1:** Iterative prefix (≤3 passes) vs flat reserve — exact prefix per actual chunk count
- **F4:** `reserveBytes` headroom vs split-after-escape — simpler parameter, avoids coupling
- **F6:** Message-based detection vs GrammY `GrammyError` — avoid new type dependency
- **F10:** DoS guards (100KB stream, 25 chunks) are conservative, invisible to normal usage
- **F7 Port injection:** PermissionPolicy belongs at composition root; relay receives port or nothing

---

Earlier work (Phases 1–4) details omitted for brevity. All code complete and tested.


---

# Phase 1-6 (Archived 2026-05-28)

# Carter — History (Summarized)

## Identity & Role

- **Agent:** Carter (Bridge Dev, Sonnet 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** SDK relay, streaming, MarkdownV2 formatting, message splitting, session discovery, named-pipe bridge
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Days 1–2 COMPLETE** (bridge plumbing + protocol migration). **Phase 6 Days 3–4 COMPLETE** (bridge integrated with relay adapter via Kat + Jun). Core bridge ready for production testing.

**Review Cycle 1 + B3 COMPLETE** (commits `22e7a44`, `e4bf8dc`): B1 listener leak, B2 stream disconnect, B3 pipe auth (ADR-10), I1/I2/I5/I6/I9, minor fixes.

**Review Cycle 2 COMPLETE** (commit `e839e1e`): N1 constant-time token compare (`timingSafeEqual`), N2 `cleanupPipeAuth()` called from `ExtensionBridge.stop()`.

Test suite: 358 passed / 4 skipped / 0 failed ✅

**2026-05-24 Dogfooding Kickoff:** Inbox decisions merged (Carter's 2 reviews consolidated into canonical decisions.md). ADR-10 finalized. Awaiting Noble Six dogfooding checklist for go-live assessment.

---

## Phases 1–5 Summary

Full Phase 1–5 documentation (MarkdownV2, message splitting, relay plumbing, session discovery spike) archived in `history-archive.md`.

**Key accomplishment:** Relay with 800ms throttle, MarkdownV2 fallback, split-chunk logic, idle eviction. 278 tests passing. Production-ready.

---

## Phase 6 Days 1–2 (2026-05-19–2026-05-20)

**Day 1: Bridge Implementation**
- Built `src/bridge/extensionBridge.ts` — named-pipe server on `\\.\pipe\reach-bridge`, JSON-Lines protocol, heartbeat (ping/pong every 30s, 5s pong window, 15s grace), fast-path disconnect via pipe close event.
- Built `extension.mjs` — CLI extension with `joinSession()`, exponential backoff reconnect (1s–300s ceiling), heartbeat, command injection stub.
- Learned: TypeScript composition pattern for typed event emitters (avoids `no-unsafe-declaration-merging` eslint; use private `_emitter + EventEmitter()` with typed overloads, not `class extends`).
- Learned: Implementation signature of event emitter overloads must use `(...args: any[]` (not `unknown[]`) to be compatible with specific listener signatures.

**Day 2: ADR-8 Protocol Migration**
- Migrated `extensionBridge.ts` and `extension.mjs` from Day 1 wire schema to ADR-8 canonical (`hello`/`session.registered`/`inject`/`stream` with `requestId`/`chunk`/`done`, heartbeat `sessionId` added).
- Changed `sendCommand()` signature: `(sessionId, payload) → boolean` → `(sessionId, text) → string | false` (returns `requestId` for relay correlation).
- Added 9 mechanical changes (ADR-8 §1–8): type names, message shapes, requestId fields, sessionId in heartbeat, streaming implementation.
- Result: 296 tests passing (baseline preserved). tsc clean. Lint clean.

---

## Phase 6 Days 3–4 (2026-05-22)

**Status:** Kat shipped relay-bridge adapter; Jun shipped 20 tests. Bridge fully integrated.

**What Kat built over Carter's extensionBridge:**
- `BridgeSession` (bridgeSession.ts) — async-iterator adapter (push-to-pull) implementing `CopilotSession`
- `BridgeSessionFactory` (bridgeSessionFactory.ts) — factory implementing `CopilotSessionFactory`
- `CompositeSessionFactory` (compositeSessionFactory.ts) — bridge-first, SDK-fallback composition
- Added `getSessionByName()` to extensionBridge.ts — maps relay's human-readable session names to bridge's internal `sessionId`
- Wired bridge + composite factory in main.ts

**Key for Carter if you touch the bridge again:**
- `extensionBridge.ts` now tracks `sessionName` in `InternalConnection` (stored from `hello` message)
- Bridge events consumed via `BridgeSession` adapter (not directly by relay) — relay.ts unchanged
- Known gap: Bridge sessions ignore `permissionCallback` (ADR-9 future — wire protocol lacks permission-request round-trip)
- All relay logic (800ms throttle, MarkdownV2 fallback, split-chunk, error handling) inherited by bridge sessions at zero code cost

---

## Design Patterns & Learnings

1. **Named-pipe multiplexing:** Single pipe, sessionId in each message, index by sessionId
2. **Async-iterator adapters:** Push (bridge events) → Pull (relay's async iterable) via queue + Promise
3. **Composition over config flags:** Composite factory (bridge-first, fallback to SDK) avoids hard-disable of either factory
4. **Type safety in protocol:** JSON-Lines with discriminated unions (`type` field) enables exhaustive type checking
5. **Streaming over single-shot:** `requestId` correlation needed for relay's per-chunk editing (800ms throttle)
6. **Typed event emitters:** Composition + overloads (not class inheritance) avoids eslint lint issues

See `history-archive.md` for earlier phases and Phase 6 spike details.

---

## 2026-05-24 — Skill Spike (issue #6)

Researched whether a Copilot CLI `skill.md` can intercept slash commands, hold per-session state, and call the named pipe. Verdict: **NO** — skill.md is a markdown instruction document only (no code surface). The surface that CAN do all three is `extension.mjs` via SDK `commands: CommandDefinition[]` in `joinSession()`. High confidence. Full analysis in `.squad/decisions/inbox/carter-skill-spike.md`.

---

## Phase 6 Day 5 (2026-05-22)

**Status:** ADR-9 (Permission Prompting Over Bridge) drafted. **GATING:** 4 open questions for Aaron before implementation begins.

**ADR-9 Summary:**
- **Problem:** `BridgeSession` silently discards `permissionCallback` — destructive tools run without user consent
- **Decision:** In-stream interleaving. 3 new message types: `permission.request`, `permission.response`, `permission.cancelled` on existing pipe (ADR-3/ADR-8)
- **Delivery scope:** Full wire schema, adapter integration (extensionBridge.ts + BridgeSession), security guidance, test scenarios (Jun's 29-scenario catalog complete)

**4 Decisions Locked for Aaron:**
1. Telegram UX shape (buttons? commands?)
2. Default `timeoutMs` (30s proposed)
3. `allow-always` scope (in-memory per-session vs. persisted)
4. Risk classification owner (extension or daemon)

**Impact on Carter's Bridge:** 
- New message types added to wire protocol union (inbound: `permission.request`, `permission.cancelled`; outbound: `permission.response`)
- New event types added to `BridgeEmitter` (`permission.request`, `permission.cancelled`)
- New helper: `bridge.sendPermissionResponse()` to send daemon→extension decisions
- No breaking changes to existing protocol; new types append to unions

**Blocking:** Production dogfooding blocked on ADR-9 resolution. This is the gating issue for Phase 6 completion.

---

## Phase 6 Dogfood Day 1 (2026-05-23)

**Status:** Investigating live dogfood bug: `bash ls` executed without ADR-9 permission prompt.

### SDK Investigation Findings

**Inspected:** `@github/copilot-sdk` v0.2.2 dist types (`types.d.ts`, `session.d.ts`, `session-events.d.ts`, `session.js`)

#### 1. `resolvedByHook` bypass (PRIMARY SUSPECT)

In `session.js:224-250`, `_handleBroadcastEvent`:
```javascript
} else if (event.type === "permission.requested") {
  const { requestId, permissionRequest, resolvedByHook } = event.data;
  if (resolvedByHook) {
    return; // BYPASSES onPermissionRequest entirely
  }
  if (this.permissionHandler) {
    void this._executePermissionAndRespond(requestId, permissionRequest);
  }
}
```
If Aaron's Copilot CLI has a pre-tool-use hook configured (in `~/.config/gh-copilot/settings.json` or similar) that auto-approves all or some tools, the CLI sets `resolvedByHook: true` in the event before it reaches the SDK. Our `onPermissionRequest` handler is never called, and the tool executes silently. This is the most likely cause.

**Key observation:** User-registered `on(eventType, handler)` handlers DO fire before `_handleBroadcastEvent` (see `_dispatchEvent`), so an `onEvent` handler in the session config will see `permission.requested` events even when `resolvedByHook: true`.

#### 2. Undocumented `PermissionRequest` kinds

`session-events.d.ts` reveals two `kind` values NOT in the exported `PermissionRequest` type (`types.d.ts`):
- `kind: 'hook'` — a pre-tool-use hook asking for confirmation on behalf of the gated tool (has `toolName` field = the gated tool)
- `kind: 'memory'` — store_memory tool (Copilot memory storage, non-destructive)

Our original classifier mapped both to `denied-by-rules` (unknown tool fallback). Fixed:
- `'hook'` → delegate to `toolName` field (the actual gated tool name)
- `'memory'` → added to `SAFE_TOOLS` (non-destructive, equivalent to read)

#### 3. Shell args shape mismatch

Real SDK `kind: 'shell'` sends `fullCommandText: string` (not `args`). Our `serializePermissionArgs` was calling `JSON.stringify(toolRequest.args ?? {})` = `'{}'` for real SDK calls. Fixed to prefer `fullCommandText` when present (falls back to `args` for backward compat with tests).

#### 4. `kind` mapping is correct for the bypass scenario

For `kind === 'shell'` on Windows: `'powershell'` (DESTRUCTIVE_TOOLS) → should prompt. So if `resolvedByHook` is NOT the cause and our handler IS being called, the classifier is correct and should prompt. Diagnostic logs will confirm.

### Changes Made

- **`src/copilot/permissions.ts`**: Added `'memory'` to `SAFE_TOOLS`
- **`src/copilot/impl.ts`**:
  - `getPermissionToolName`: handle `kind: 'hook'` by delegating to `req.toolName` (the gated tool)
  - `serializePermissionArgs`: now takes the full `ToolPermissionRequest`; uses `fullCommandText` for shell
  - `buildPermissionDiagnosticHandler`: `SessionEventHandler` passed as `onEvent` to session config; logs `permission.requested` events including `resolvedByHook`
  - `makePermissionHandler`: added diagnostic logging before EVERY branch (kind, toolName, decision)
  - `resumeSession` / `createSession` configs: added `onEvent: buildPermissionDiagnosticHandler(sessionName)`

### Next Step for Aaron

See findings written to `.squad/decisions/inbox/carter-permission-prompt-dogfood-bug.md`.

---

## 2026-05-24 — /afk Mode Protocol Opens (post-realignment)

Post-realignment opens analysis: identified 8 concrete protocol opens under corrected mirror/broadcast + machine-wide AFK semantics — including mode-state singleton, new `mirror.input` message type, `relay.command` for slash relay, machine-wide broadcast mechanics, Spawn/Resume message surface, and 2 TBDs (local prompt echo direction, spawn mechanism). Full analysis in `.squad/decisions/inbox/carter-afk-mode-protocol-opens.md`.

---

## 2026-05-24 — /afk–/back Protocol Gap Audit

Audited bridge and pipe protocol for /afk user story; identified 4 new message types needed (`afk.request`, `afk.activated`, `back.request`, `back.confirmed`), 3 daemon-side gaps (no session-to-topic map, no active-sink state machine, no topic-creation trigger), and 2 extension-side gaps (no /afk command handler, no output suppression). Confirmed switching (not broadcast) semantics. Full analysis in `.squad/decisions/inbox/carter-afk-protocol-gaps.md`.


**[2026-05-24] Scribe log entry:** Skill-spike verdict: NO (HIGH). SDK commands field is correct surface for /afk. Authored protocol gap analyses. Permission prompt diagnostics deployed. Await Aaron rerun.

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

