
---

# Phase 8.5 Sprint — Task Completion Decisions

## Carter — Task 1: copyExtension.ts Decision Record

**Date:** 2026-05-29T23:23:02-07:00  
**Author:** Carter (Bridge Dev)  
**Task:** Phase 8.5 Task 1 — Extension copy installer

### Decision: Runner pattern for `install:extension`

**Options considered:**
- `node --import tsx/esm src/install/copyExtension.ts` — runs TS source directly, no build step needed
- `node dist/install/copyExtension.js` — runs compiled JS, consistent with `service:install`/`service:uninstall`

**Chose:** `node dist/install/copyExtension.js`

**Reasoning:** Matches the established pattern in all other runtime scripts (`service:install`, `service:uninstall`). The handoff doc explicitly lists this form. Aaron already runs `npm run build` before install — the pre-build requirement is a documented step. Keeping the pattern consistent avoids a split where some install scripts use tsx and others don't.

**Implication:** `npm run install:extension` requires `npm run build` first. This is expected and matches the acceptance criteria in the handoff (`npm run build && npm run install:extension`).

### Decision: Project root detection

Used `path.resolve(__dirname, '..', '..')` from `dist/install/copyExtension.js` to walk up to the project root and find `extension.mjs`. This is analogous to the `getProjectRoot()` walk in `src/service/install.ts` but simpler — the compiled path depth is fixed (`dist/install/`), so two `..` steps are reliable without the filesystem walk.

### Deferred

Dev-symlink/junction logic (`NODE_ENV=development`) deferred per task spec. Left as a TODO comment referencing handoff Q3 (`.copilot/reach-install-handoff.md §"Dev Shortcut (Dogfooding)"`).

---

## Carter — Task 2: Full Orchestrator Decision Record

**Date:** 2026-05-29T23:36:06-07:00  
**Author:** Carter (Bridge Dev)  
**Task:** Phase 8.5 Task 2 — Full install orchestrator, uninstaller, dev junction

### Decision: `existsSync` + `rmSync` over `lstatSync` for removal

**Context:** Initial implementation used `fs.lstatSync` + conditional `unlinkSync`/`rmSync` to safely remove paths that might be junctions vs plain directories.

**Problem:** Jun's tests mock `fs.existsSync` and `fs.rmSync` but not `fs.lstatSync`. Using `lstatSync` on non-existent test paths (which aren't real filesystem paths) caused unexpected `ENOENT` failures.

**Decision:** Use `fs.existsSync` + `fs.rmSync({ recursive: true, force: true })` for all removal. On Windows, `rmSync` with `recursive: true` removes the junction link itself (not the target contents), which is the correct behavior for dev-mode junctions.

**Trade-off accepted:** Slightly less precise — does not distinguish junctions from plain dirs. In practice this is fine because `rmSync` handles both correctly on Windows.

### Decision: Source file check deferred to production branch in copyExtension

**Context:** Dev mode creates a junction pointing `reach/` to the repo root. The extension.mjs is accessible via the junction — no explicit copy needed.

**Decision:** Move the `existsSync(sourcePath)` guard inside the `else` (production) branch. Dev mode skips it.

**Implication for Jun's tests:** TC10–TC13 do not mock SOURCE_PATH. If the check were in the shared preamble, those tests would fail. Moving it inside the production branch makes dev mode tests clean.

### Decision: Orchestrator structure for index.ts

`runInit()` is the exported function signature for Jun's tests and for the eventual Task 2 orchestrator. Flow:

1. Config wizard (TTY-gated; non-TTY + missing vars = exit non-zero with instructions)
2. `copyExtension()` — sync, exits on error
3. Print next-step pointers **before** calling `install()` (service install calls `process.exit` internally via node-windows events — code after it never runs)
4. `install()` from `src/service/install.ts` — handles its own exit

**Implication for Jun:** `install()` is async but resolves before the 'start' event fires (event handler calls process.exit). Tests must mock `install` from `src/service/install.ts`.

### Decision: Uninstaller step ordering

Extension dir and LOCALAPPDATA deletion happen **before** calling `uninstall()` from service/install.ts. This is required because service uninstall is event-driven and calls `process.exit` in its 'uninstall' event handler — any code after calling `uninstall()` is unreachable.

Order: removeExtension() → wipeLocalData() (if --wipe) → uninstall()

### Public function signatures (for Jun)

```typescript
// copyExtension.ts
export function copyExtension(): void

// index.ts
export async function runInit(): Promise<void>

// uninstall.ts
export interface UninstallOptions { wipe: boolean }
export function runUninstall(opts: UninstallOptions): void
```

No changes from what's natural. Jun can import and test all three directly.

---

## Issue #8 Fix: mirror.input SDK API Drift

**Date:** 2026-05-29T23:23:03-07:00  
**Author:** Noble Six (Lead / Architect)  
**Status:** Implemented  
**Issue:** #8 — mirror.input broken: SDK 0.2.2 returns Promise<string>, extension expects async iterable

### Root Cause

The extension (`extension.mjs`) held a direct SDK `CopilotSession` reference (from `joinSession()`) and consumed its `send()` method as an async iterable:

```js
// extension.mjs:374 — BROKEN on SDK v0.2.2
for await (const chunk of sdkSession.send(text)) { ... }
```

`@github/copilot-sdk@0.2.2` changed `send()` to return `Promise<string>` (a message ID, not an async iterable). Streaming now flows through event emitters:
- `session.on('assistant.message_delta', handler)` — per-chunk deltas
- `session.on('session.idle', handler)` — completion signal
- `session.on('session.error', handler)` — error signal

The daemon side (`src/copilot/impl.ts` / `CopilotSessionAdapter`) was **already correct** — it had been adapted to v0.2.2's event-emitter model. The extension.mjs was not updated at the same time, creating a split that broke only the direct mirror.input path.

Also: the old code passed a bare string to `send(text)` — the v0.2.2 API requires `MessageOptions` (`send({ prompt: text })`).

### Decision

**Replace the `for await` loop in `streamSdkResponse` with the event-emitter streaming pattern.**

**Options Evaluated:**

| Option | Summary | Decision |
|--------|---------|----------|
| A | `await send()` for the full response (batch, no streaming) | ❌ `send()` returns a message ID string, not the reply text |
| B | Add an adapter wrapper to convert Promise→AsyncIterable | ❌ Unnecessary indirection; the fix is straightforward in-place |
| C | Use the event-emitter pattern directly in `streamSdkResponse` | ✅ Chosen — mirrors the proven pattern in `impl.ts`; no new abstractions |

**Why Option C:** The daemon side (`CopilotSessionAdapter.bridge()`) already solves this exact problem with the event-emitter pattern. That pattern is stable and tested. Replicating it in `streamSdkResponse` is the lowest-risk fix.

### Implementation

**File changed:** `extension.mjs` — `streamSdkResponse` function replaced.

New pattern:
1. Register `session.on('assistant.message_delta', ...)` before sending — writes each chunk as a `stream` frame to the pipe
2. Register `session.on('session.idle', ...)` — resolves the outer Promise
3. Register `session.on('session.error', ...)` — rejects the outer Promise
4. Call `sdkSession.send({ prompt: text })` fire-and-forget — errors caught and forwarded to reject
5. 5-minute timeout guard (matching `impl.ts` `STREAM_TIMEOUT_MS`)
6. `settled` flag prevents double-resolve/reject if multiple signals fire
7. All listeners are unsubscribed on completion (via `cleanup()`)

**Backpressure:** The original loop had drain-wait logic. The new version writes without drain-wait. Rationale: the pipe is a local Unix/named pipe; write rate is bounded by SDK event delivery; Node.js buffers internally. Drain handling can be reintroduced if back-pressure issues are observed in production.

### Test Coverage

**File changed:** `tests/bridge/extension-protocol-drift.test.ts` — new `describe` block added.

Four static-analysis assertions on `extension.mjs` source text:
1. `for await ... of sdkSession.send(` is **absent** (old broken pattern)
2. `sdkSession.on('assistant.message_delta', ...)` is **present** (event-emitter chunks)
3. `sdkSession.send({ prompt: ...)` is **present** (correct MessageOptions shape)
4. `sdkSession.on('session.idle', ...)` is **present** (completion detection)

These tests will fail immediately if the code is regressed to the old pattern, catching API drift before runtime.

### Architectural Notes

**Split Adaptation Problem:** Two places hold SDK sessions in Reach:
1. **Daemon** (`src/copilot/impl.ts`): `CopilotClientImpl` creates sessions via `CopilotClient.createSession()` / `resumeSession()`, wrapped in `CopilotSessionAdapter`.
2. **Extension** (`extension.mjs`): `joinSession()` returns a raw SDK `CopilotSession`.

Both must be updated whenever the SDK streaming API changes. The daemon is protected by TypeScript + the `CopilotSession` interface contract. The extension is plain JS — no compile-time safety.

**Recommendation for Phase 9:** Extract a shared `streamingAdapter.mjs` (or include a minimal typed helper) so both paths share one implementation of the event-emitter pattern. This reduces the surface for future drift.

**Issue #9 (Telegram Echo):** The issue body notes that Bug #2 (double echo) "likely resolves with this fix." Assessment: **Probable but not guaranteed.** The echo was occurring because `mirror.input` never reached the model (crashed at the `for await` line), so responses were not being generated and the daemon may have re-sent messages. With the streaming path now functional, the double-echo should stop. Marked for re-verification in dogfood.

### Verification

- `npx tsc --noEmit` — clean (extension.mjs is JS; tsc runs on `src/` only)
- `npm run lint` — zero warnings
- `npx vitest run` — all tests pass including the 4 new Issue #8 regression guards

---

## Jun Task 3 — copyExtension.ts Test Infrastructure Decisions

**Date:** 2026-05-29T23:27:00-07:00  
**Author:** Jun (Test Engineer)  
**Task:** Phase 8.5 Task 3 — Write tests for src/install/copyExtension.ts

### Decision 1: Test File Location

**Choice:** `tests/install/copyExtension.test.ts`

**Alternatives considered:**
- `tests/unit/install/copyExtension.test.ts` — spec document suggested this path, but the `tests/unit/` directory does not exist anywhere in the repo. All existing tests live at `tests/<feature>/` (e.g., `tests/service/`, `tests/config/`, `tests/bridge/`).

**Rationale:** Mirror the established repo convention. Creating a `tests/unit/` subtree would be a convention-breaking exception with no existing precedent.

### Decision 2: FS Mocking Strategy — vi.mock('fs') with spread actual

**Choice:** `vi.mock('fs', async (importOriginal) => { const actual = ...; return { ...actual, existsSync, mkdirSync, copyFileSync } })`

**Alternatives considered:**
- `memfs` / in-memory filesystem — would require installing a new devDependency and registering a custom resolver. No existing test in the suite uses memfs. Overkill for a function that calls 3 fs methods (existsSync, mkdirSync, copyFileSync).
- `vi.mock('node:fs')` — would work but the source module uses `import * as fs from 'fs'` (bare specifier), so the mock specifier must match.
- tmpdir + real fs — inappropriate: tests would touch the real APPDATA if env is not completely overridden; platform-sensitive; slower.

**Rationale:** Exact same pattern as `tests/service/install.test.ts`. Spreads actual so non-overridden exports (constants, `Stats`, etc.) remain available to any transitive import.

### Decision 3: process.exit spy — throw instead of swallow

**Choice:** `vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(\`process.exit(\${code})\`); })`

**Rationale:** Same pattern used throughout the test suite. Throwing lets `expect(() => fn()).toThrow('process.exit(1)')` work cleanly. Swallowing would let subsequent lines in the production function run after the mock exit, producing false positives.

**Caveat:** `vi.clearAllMocks()` in `beforeEach` resets mock implementations (sets them to `undefined`). The implementation must be re-established in `beforeEach` after the `clearAllMocks` call. This is the same pattern documented in Jun's Phase 8 P1 sprint learning (history.md).

### Decision 4: Source path determination in tests

**Challenge:** `copyExtension.ts` resolves the project root via `path.resolve(__dirname, '..', '..')`. Under vitest + ESM, `__dirname` is the actual source directory (`src/install/`), so `getProjectRoot()` resolves to `process.cwd()` (the project root) at test time.

**Choice:** Use `path.join(process.cwd(), 'extension.mjs')` as the expected `SOURCE_PATH` constant in tests.

**Rationale:** `process.cwd()` in vitest is the project root (where `vitest.config.ts` lives). This matches what the production code resolves. If Carter's `getProjectRoot()` changes to a walk-up approach (as in `service/install.ts`), `process.cwd()` would still match because the project root `package.json` is at `process.cwd()`.

### Decision 5: MOCK_APPDATA includes a space in the username

**Choice:** `'C:\\Users\\Aaron Smith\\AppData\\Roaming'`

**Rationale:** TC7 specifically exercises APPDATA paths with spaces and unicode. Rather than a clean ASCII path for the default mock and a separate constant for TC7, using the spaced path as the default constant means TC1–TC6 are also exercised with a realistic path. The unicode variant (Aaröñ Śmíth) is kept exclusive to TC7 to avoid obscuring other assertions.

### What Carter's Implementation Needs for Tests to Pass

At the time of writing, `src/install/copyExtension.ts` was already implemented by Carter. Tests pass GREEN against that implementation. If Carter changes the file, the following contracts must hold:

1. **Export:** `export function copyExtension(): void` (sync, not async)
2. **APPDATA check:** reads `process.env['APPDATA']`; exits 1 if falsy; error message contains "APPDATA"
3. **Copilot CLI check:** calls `fs.existsSync` on a path containing `GitHub Copilot` + `extensions`; exits 1 if false; error message contains "GitHub Copilot CLI not detected"
4. **mkdir:** calls `fs.mkdirSync(reachDir, { recursive: true })` when reach/ doesn't exist; catches and exits 1 on throw with the error message in the console.error output
5. **Source check:** calls `fs.existsSync` on a path ending with `extension.mjs` that does NOT contain the APPDATA path; exits 1 if false; error message contains "Source file not found"
6. **Copy:** calls `fs.copyFileSync(sourcePath, targetPath)`; catches and exits 1 on throw with the error message in the console.error output
7. **Log:** calls `console.log` with a string containing the full target path

### Test Count Summary

| ID  | Name                                               | Status |
|-----|----------------------------------------------------|--------|
| TC1 | Happy path: copies and logs                        | ✅ full |
| TC2 | First install: creates reach/ subdir               | ✅ full |
| TC3 | Upgrade: idempotent overwrite                      | ✅ full |
| TC4 | No Copilot CLI: exits 1 with detected message      | ✅ full |
| TC5 | APPDATA unset: exits 1 with clear APPDATA message  | ✅ full |
| TC6 | Source file missing: exits 1 with source message   | ✅ full |
| TC7 | Spaces + unicode in APPDATA path                   | ✅ full |
| TC8 | mkdir EPERM: exits 1 with EPERM in message         | ✅ full |
| TC9 | copyFileSync EPERM: exits 1 with EPERM in message  | ✅ full |

**9 full tests, 0 todo. All GREEN against Carter's implementation.**

---

## Jun Task 2 — Test Infrastructure Decisions

**Date:** 2026-05-29T23:44:00-07:00  
**Author:** Jun (Test Engineer)  
**Phase:** 8.5 Task 2 — Junction mode, uninstall, orchestrator

### Scope

Three test files:
1. `tests/install/copyExtension.test.ts` — extended with TC10–TC14 (junction mode)
2. `tests/install/uninstall.test.ts` — new (6 tests, UN1–UN6)
3. `tests/install/index.test.ts` — new (13 tests, IX1–IX13)

### Decisions

**D1: Readline mock uses an answer queue (not jest-style argument matchers)**

**Decision:** `rlAnswerQueue: string[]` pushed in each test; `question()` calls `cb(rlAnswerQueue.shift() ?? '')`. The mock is wired through `vi.hoisted()` so the queue is shared between the `vi.mock('readline', ...)` factory and the test bodies.

**Rationale:** Carter's implementation calls `readline.createInterface` + `rl.question` N times (once per missing var). An ordered queue cleanly simulates multi-prompt flows without needing to match on prompt text, which is fragile. Empty answer (`''`) triggers the empty-input exit path, matching production behavior.

**D2: `vi.mock('../../src/install/copyExtension.js')` — relative path to mock local sibling**

**Decision:** When index.ts imports `'./copyExtension.js'`, the test file at `tests/install/index.test.ts` mocks it as `vi.mock('../../src/install/copyExtension.js')`.

**Rationale:** Vitest resolves both import paths to the same file, so the mock intercepts correctly. This is consistent with the pattern in `tests/config/env.test.ts` which mocks `../../src/config/config.js`.

**D3: Service install mock exports all expected symbols**

**Decision:** The `vi.mock('../../src/service/install.js', ...)` factory exports: `install`, `uninstall`, `createService`, `resolveCurrentUser`, `promptPassword`. Even though only `install` is called by `runInit`, exporting the full shape prevents TypeScript-level import errors if the module is imported with named bindings elsewhere.

**Rationale:** Previous experience (Phase 8 P1) showed that sparse mocks cause "not a function" errors when other module code uses named imports. Better to over-mock.

**D4: `process.stdin.isTTY` controlled via `Object.defineProperty` (not spy)**

**Decision:** Set TTY state with `Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })`. Restore in `afterAll`.

**Rationale:** `process.stdin.isTTY` is a plain property, not a getter — `vi.spyOn` cannot stub it. `Object.defineProperty` with `configurable: true` is the standard pattern for non-spy overrides.

**D5: `vi.clearAllMocks()` NOT `vi.restoreAllMocks()` in `beforeEach`**

**Decision:** Use `vi.clearAllMocks()` in `beforeEach`, then immediately re-establish all mock implementations in the same block.

**Rationale:** Phase 8 P1 sprint learned that `vi.restoreAllMocks()` wipes ALL tracked `vi.fn()` implementations, including those created in `vi.mock()` factory closures. `clearAllMocks()` only resets call records, leaving implementations intact. Re-establishing the handful of spy implementations manually (exit, console) is cheap and predictable.

**D6: `src/install/uninstall.ts` — Jun created the stub**

**Decision:** Carter had not yet created `uninstall.ts` when tests were written. Jun created a minimal stub exporting the correct interface (`UninstallOptions`, `runUninstall`). Carter is expected to replace the body — the exported types and function signature must be preserved.

**Required final shape:**
```typescript
export interface UninstallOptions { wipe: boolean; }
export async function runUninstall(opts: UninstallOptions): Promise<void>
```

**D7: Junction TC10–TC14 confirmed GREEN — Carter landed junction support**

**Observation:** TC10–TC14 (junction mode tests) passed immediately without needing Carter to make any changes. Carter had already implemented the `NODE_ENV=development` branch in `copyExtension.ts` (lines 49–75) by the time tests were run. The junction log line is `"[reach] Extension linked (dev mode): ${targetDir}"` — TC11's assertion for `/linked|dev/i` matches this.

### Final test counts

| File | Tests | Status |
|------|-------|--------|
| tests/install/copyExtension.test.ts | TC1–TC14 (14) | 14/14 GREEN ✅ |
| tests/install/uninstall.test.ts | UN1–UN6 (6) | 6/6 GREEN ✅ |
| tests/install/index.test.ts | IX1–IX13 (13) | 13/13 GREEN ✅ |
| **Total** | **33** | **33/33 GREEN ✅** |

Full suite after these additions: `npx vitest run` → 33 new pass, all 33 GREEN.
`npx tsc --noEmit` → GREEN.

---

## Kat Task 4: README Install Section Update

**Date:** 2026-05-29T23:36:10-07:00  
**Agent:** Kat  
**Task:** Phase 8.5 Task 4 — Update README install section for new install story

### Summary

Updated README.md to document the new Phase 8.5 install workflow, replacing the old multi-step "Setup" and "Windows Service" sections with a streamlined flow centered on `npm run init`.

### Changes Made

**Consolidated Sections:**
- **Old:** Separate "Setup" (steps 1–5) + "Windows Service" + old env config
- **New:** Single cohesive "Installation" workflow with subsections

**New Sections Added:**

1. **Quick Start** — Happy path: clone → npm install → npm run build → npm run init (4 lines + explanation)
2. **Installation** subsections:
   - **What `npm run init` Does** — Ordered list of 4 steps (config wizard → extension → service → next steps)
   - **Configuration** — Required (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`) vs Optional (`TELEGRAM_CHAT_ID`, `REACH_MODEL`, etc.)
   - **Windows Service Details** — Service name, auto-restart, event logging, state preservation
3. **Development Workflow** — NODE_ENV=development junction trick + manual reinstall
4. **Upgrading** — Fast path (`git pull && npm run build && npm run install:extension`) + full path (`npm run init`)
5. **Uninstall** — Preserve state (default) vs Full reset (`--wipe`)
6. **Platform Support** — Windows-only for Phase 8.5–9; cross-platform deferred

### Removed
- Old "Setup" section (lines 18–82 in original)
- Old "Windows Service" section (lines 176–201 in original) — consolidation into Installation
- Old pairing mode explanation (moved to Configuration)

### Voice & Formatting
- Matched existing README style: practical, concise, PowerShell examples with $env: syntax
- No new Markdown features; used existing lists, code blocks, bold/italic
- Section ordering: Quick Start → Installation → Dev → Upgrading → Uninstall → Platform

### Line Count Delta

| Section | Old | New | Change |
|---------|-----|-----|--------|
| Quick Start | 0 | 8 | +8 |
| Installation | 65 | 38 | −27 |
| Platform Support | 0 | 2 | +2 |
| Total removed (old Windows Service) | 26 | 0 | −26 |
| **Net change** | ~65 | ~48 | **−17 lines** |

### Script Name Mismatches Found & Status

**Missing Scripts (referenced in README but not in package.json):**

| Script | Referenced In | Status | Notes |
|--------|---------------|--------|-------|
| `npm run init` | Quick Start, Installation, Upgrading | ✗ MISSING | Primary entry point (Aaron's decision). Will be added in Task 2 (orchestrator) |
| `npm run uninstall` | Uninstall section | ✗ MISSING | Will be added in Task 2 (orchestrator) |
| `npm run uninstall -- --wipe` | Uninstall section | ✗ MISSING | Will be added in Task 2 (orchestrator) |

**Existing & Verified:**

| Script | Status | Used In |
|--------|--------|---------|
| `npm run install:extension` | ✓ EXISTS | Development Workflow, Upgrading |
| `npm run build` | ✓ EXISTS | Quick Start, Upgrading |

### Rationale for Not Changing Script References

Aaron's locked decisions (from task brief) explicitly specify `npm run init` as the primary entry point, not `npm run install` or `npm run setup`. The current mismatch reflects that:
1. **Task 1 (Carter) completed:** `install:extension` script added and `copyExtension.ts` shipped
2. **Task 2 (Kat or Carter) pending:** Full orchestrator (`index.ts`, `configWizard.ts`, `uninstall.ts`) + npm scripts will be added
3. **Task 4 (Kat) — this task:** README updated to document final design

The scripts referenced in the README will exist when Task 2 completes.

### Architecture Decisions

1. **Single "Quick Start" block** — One simple 5-command sequence for users, not multi-step callouts
2. **What `npm run init` Does** — Explicit, ordered walkthrough to set expectations
3. **Config wizard integration** — Prompts explained inline (no separate "Configuration Wizard" section)
4. **Development Workflow separate** — NODE_ENV=development junction trick prominent; fast iteration path documented
5. **Uninstall with `--wipe` flag** — Mirrors Unix tool patterns (preserve state by default, full reset via flag)
6. **Platform Support as final note** — Windows-only disclaimer placed at end, not buried in prerequisites

### Validation Notes

- ✓ README voice & formatting matches existing style (no new Markdown features introduced)
- ✓ All sections are self-contained and scannable (as required by Aaron)
- ✓ Practical focus: no marketing copy, no screenshots, no badges
- ✓ Windows-only note present
- ✗ **Scripts don't exist yet** (see table above) — will be resolved in Task 2

### Next Steps

- Task 2 (Orchestrator implementation): Add `npm run init` and `npm run uninstall` scripts to package.json
- No further README changes needed after Task 2 completes

---

# Phase 9: Persona Review Cycles 1 & 2

## Kat — Phase 9 Review Decisions: I10 + I11

**Date:** 2026-05-30  
**Author:** Kat  
**Status:** Shipped (pending Carter wire-up for I10 warning surface)

---

## Jun — Phase 9 Review Tests: Decisions

**Date:** 2026-05-30  
**Author:** Jun (Test Engineer)  
**Wave:** Phase 9 review — test-quality blockers + anticipatory regression tests

---

## Jun — Cycle 2 Decisions: handlers.test.ts migration

**Date:** 2026-05-30  
**Author:** Jun  
**Status:** Complete

---

## Carter — Phase 9 Review Fix Wave Decisions

**Date:** 2026-05-30  
**Author:** Carter  

---

# Phase 8.5: Reach Install Story (Decision)

**Date:** 2026-05-29T22:22:08-07:00  
**Author:** Noble Six (Lead / Architect)  
**Status:** Design Complete — Ready for Phase 8.5 Execution

# Noble Six — Install Story Decision

**Date:** 2026-05-29T22:22:08-07:00  
**Author:** Noble Six (Lead / Architect)  
**For:** Squad team (Carter, Kat, Jun, Scribe)  
**Full doc:** `.copilot/reach-install-handoff.md`

---

# PR #7 Cloud Review Cycle Dispositions (Phase 8)

**Date:** 2026-05-28  
**Cycles:** 1–4 (Extended: Real production bugs found)  
**Owner:** Kat (Bot Dev)  
**Status:** All findings addressed; branch f78ccd6 awaiting PR

## Dogfood Bug Fixes (#3, #4)

# Kat — Dogfood Bugs #3 and #4 Fix Notes

**Date:** 2026-05-29T22:34:52-07:00  
**Branch:** `user/aaron/dogfood-bugs-3-4`  
**Author:** Kat (Bot Dev)

---

## Cycle 1 — afkStreamRouter.ts State Leaks

# kat-pr7-cycle1 — PR #7 Copilot Review Fixes

**Date:** 2026-05-28T22:45:13-07:00  
**Author:** Kat  
**Branch:** user/aaron/phase-8  
**Commit:** 09d0c40

---

## Cycle 2 — handleChunk Placeholder Retry

# Decision Note — PR #7 Cycle 2: handleChunk Placeholder Retry

**Date:** 2026-05-28T22:45:13-07:00  
**Author:** Kat (Bot Dev)  
**File:** `src/bot/afkStreamRouter.ts` — `handleChunk`  
**Commit:** `2f12755`

---

## Cycle 3 — Telegram Display Cap + isActive Guard

# Decision Note — PR #7 Cycle 3
**Author:** Kat  
**Date:** 2026-05-28T23:25:16-07:00  
**File:** `src/bot/afkStreamRouter.ts`

---

## Cycle 4 — Production Bug: Timer Leak + Fleet Tests

# Decision Note — PR #7 Cycle 4 (Kat)

**Date:** 2026-05-28T23:25:16-07:00  
**Author:** Kat  
**Context:** Copilot code review cycle 4 on PR #7 (extended past maxCycles by Aaron — real production bug found).

---


# Phase 8 Dogfooding Plan (2026-05-29)

**Date:** 2026-05-29T21:53:17-07:00  
**From:** Noble Six (Lead/Architect)  
**Status:** Ready for Aaron's execution

## Summary

Comprehensive dogfooding plan synthesized from Phase 6 checklist, Phase 7 ADR-11 decisions, and Phase 8 P1+watch sweep deliverables. Validates production-facing behavior before Phase 9 design decisions lock in.

**Location:** `.copilot/reach-dogfood-plan-phase8.md`

## What Was Tested

Phase 8 completed four hardening items:
1. **Permission prompting edge cases** (ADR-9, no-timeout guarantee)
2. **AFK mode fleet binding & stream routing** (ADR-11 + F4 refactor)
3. **Multi-chunk stream truncation & edge cases** (Cycle 3 fixes)
4. **Config guard for deny-all protection** (N2 guard)

## Plan Structure

**4 scenario groups, 16 total scenarios:**

| Group | Scenarios | High-Risk Behavior |
|-------|-----------|-------------------|
| A: Permission Prompting | 5 | No-timeout guarantee, concurrent prompts, deny execution |
| B: AFK Mode | 6 | Auto-binding, fleet join, mid-stream deactivation |
| C: Stream Routing | 6 | Truncation, empty placeholder, transient failure, race conditions |
| D: Config Guard | 2 | Deny-all fatal exit + actionable message |

**Success bar:** ≥80% green (≥13/16), zero critical severity.  
**Time estimate:** 45–90 minutes.

## Key Architectural Notes

### Mirror Rate Limiter Extraction (Future)

During F4 soft refactor (watch sweep), identified `allowMirrorInput` + `mirrorRates`/`globalMirrorRate` as a second cohesive extractable unit. Not extracted now because `afkMode.ts` is comfortably under 700 LOC post-refactor (649 LOC).

**Natural trigger:** Extract when file approaches 700 again or rate-limit logic gains complexity.

### ADR-10 Pipe Token Validation

Pipe authentication (token validation on extension side) is documented but not implemented. Not a blocker for Phase 8 dogfooding on solo machine, but is a pre-production gap flagged for Phase 9+.

## Triage Protocol

**Critical (data loss, security):** File immediately, halt dogfooding.  
**High (command fails, stream broken):** File immediately, continue other scenarios.  
**Medium (UX friction, edge case):** Capture in "dogfood findings" issue after session.

All issues labeled `squad` for team visibility.



---

# Phase 9 Sprint — Dogfood Feedback Resolutions

# Noble Six Phase 9 Triage — Findings

**Date:** 2026-05-30T11:32:20-07:00  
**Author:** Noble Six (Lead / Architect)  
**Context:** Phase 9 triage for Aaron's 3 dogfood feedback items

---

**Filed to:** `.squad/decisions/inbox/noble-six-phase9-triage.md`  
**Next:** Merge to decisions.md after Phase 9 sprint approval


# Kat — Phase 9 Item 1: Orientation Message Decisions

**Date:** 2026-05-30T11:49:29-07:00
**Author:** Kat (Bot Dev)
**Task:** Phase 9 Item 1 — AFK topic orientation message + /status command

---

## Files Changed

| File | Change |
|------|--------|
| `src/bridge/protocol.ts` | Added `lastAssistantExcerpt?: string` to `AfkRequestMessage` |
| `src/bot/afkBridgePort.ts` | Updated `AfkBridgeEvents['afk.request']` tuple type |
| `src/bridge/extensionBridge.ts` | Updated `on('afk.request')` signatures + emit with excerpt |
| `extension.mjs` | Added `lastAssistantMessage` cache, `assistant.message` listener, excerpt in `sendModeRequest()` |
| `src/bot/afkMode.ts` | TopicBinding.orientationSent, lastKnownExcerpts map, formatOrientationMessage, sendOrientationMessage, handleStatusCommand, globalModel option |
| `src/bot/commands.ts` | Added `'status'` to BOT_COMMANDS |
| `src/bot/handlers.ts` | Added `statusProvider` to HandlerOptions, registered `/status` command, updated /help |
| `src/main.ts` | Passed `globalModel` and `statusProvider: afkMode` |
| `tests/bridge/afk-request-dispatch.test.ts` | Updated expectation to include `undefined` excerpt arg |
| `tests/bridge/extension-protocol-drift.test.ts` | Updated AfkRequestMessage field assertions |


# Phase 9 Item 2 — Slash Command Pass-Through Decisions

**Date:** 2026-05-30  
**Author:** Carter  
**Phase:** 9 Item 2 — Telegram → CLI slash command relay

---

## Coordination note for Jun

`isBotCommand` is exported as a named export from `src/bot/commands.ts`.
`BOT_COMMANDS` is typed `ReadonlySet<string>` (declared with explicit type annotation,
initialized from `new Set([...])`). Both names match the assumptions in the design doc.


# Kat — Phase 9 Item 3 Config Schema Decisions

**Date:** 2026-05-30T11:46:28-07:00
**Author:** Kat (Bot Dev)
**Task:** T5 — Config schema extension + knownCwds helpers
**Files:** `src/config/config.ts`, `src/config/knownCwds.ts`

---

## 7. Persistence pattern

Reuses existing `saveConfig()` atomic write (write to `<path>.tmp` → `fs.rename`). No new I/O abstractions introduced.


# Phase 9 Item 3 — /cwd Command Group + /new --cwd Flag

**Author:** Carter  
**Date:** 2026-05-30  
**Phase:** 9 Item 3 (T6 + T7)

---

## Coordination Note for Jun

Function signatures match the design doc:
- `isBotCommand()` — unchanged (Item 2, already green)
- `BOT_COMMANDS` — now includes `'cwd'` (8 commands total)
- `registerHandlers(options: HandlerOptions)` — `configPath?: string` added as optional field
- No new exported functions beyond what's documented; `/cwd` logic is internal to `registerHandlers`

The `relativeTime()` helper is a private (non-exported) function in `handlers.ts`. If Jun needs to test it independently, extract it to a utility module and I'll update the import.


# Jun — Phase 9 Item 2 Test Infrastructure Decisions

**Date:** 2026-05-30T11:46:29-07:00
**Author:** Jun (Test Engineer)
**Context:** Anticipatory tests for Phase 9 Item 2 — slash command pass-through (isBotCommand guard)

---

## D7 — BOT_COMMANDS Expected Members

Per design doc §Item 2:
```
['new', 'list', 'remove', 'resume', 'help', 'pair']
```

If Carter adds new bot commands (e.g., `'back'`), add them to `isBotCommand.test.ts` `BOT_COMMANDS` describe block. The `it.each` test will enforce this mechanically once the module is importable.


# Jun — Phase 9 Item 3 Test Infrastructure Decisions

**Date:** 2026-05-30T12:16:00-07:00  
**Author:** Jun (Test Engineer)  
**Status:** ALL GREEN — Carter's T6/T7 already landed when tests ran.

---

# Kat — Phase 9 README Documentation

**Date:** 2026-05-30T12:18:53-07:00
**Author:** Kat (Bot Dev)
**Task:** Document Phase 9 work in README.md
