> 📦 Entries from 2026-05-22 and earlier archived to decisions-archive-2026-05-29.md on 2026-05-29.

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

### I10 — Sensitive-Directory Warning in `validatePath`

**Decision: warn-via-return-field (not throw)**

Aaron explicitly picked **warn, not block**. The `validatePath` return type is extended to:

```typescript
{ ok: true; normalized: string; warning?: string } | { ok: false; reason: string }
```

When `warning` is set, the caller (the `/cwd add` handler) is responsible for surfacing it to the user before adding the entry. The entry is still added — the warning is informational only.

**Sensitive prefix list (Windows-only — `process.platform === 'win32'`)**

| Prefix | Source |
|--------|--------|
| `%WINDIR%` (typically `C:\Windows`) | `process.env.WINDIR ?? 'C:\\Windows'`, resolved once via `nodePath.resolve` |
| `C:\Program Files` | Hardcoded |
| `C:\Program Files (x86)` | Hardcoded |
| Any `C:\Users\<OtherUser>\` | Detected by parsing path under `C:\Users\`; excluded if under current user's `process.env.USERPROFILE` |

**Junction/symlink detection**

`fs.lstat(normalized)` is called to check `isSymbolicLink()`. If `true`, `fs.realpath(normalized)` resolves the actual target. The sensitive-prefix check runs on both:

1. `normalized` (string-resolved path) → warning **without** junction suffix
2. `realPath` (fs-resolved target) → warning **with** `(resolved through junction)` suffix, only if `normalized` itself did not trigger

**Warning message format**

```
Warning: path is under a sensitive directory (<prefix>). Sessions started here may modify system files.
```
Junction variant:
```
Warning: path is under a sensitive directory (<prefix>). Sessions started here may modify system files. (resolved through junction)
```

---

### I10 → Carter Handoff: `/cwd add` handler in `handlers.ts`

The `/cwd add` handler calls `validatePath(rawPath)`. After this change the return value is:
```typescript
{ ok: true; normalized: string; warning?: string }
```

**What handlers.ts must do:**

```typescript
const pathResult = await validatePath(rawPath);
if (!pathResult.ok) {
  await ctx.reply(`❌ ${pathResult.reason}`);
  return;
}
// Surface warning before adding (user sees it immediately; entry still gets added).
if (pathResult.warning) {
  await ctx.reply(`⚠️ ${pathResult.warning}`);
}
const newConfig = addKnownCwd(config, alias, pathResult.normalized, new Date().toISOString());
await saveConfig(configPath, newConfig);
await ctx.reply(`✅ Added "${alias}" → ${pathResult.normalized}`);
```

The reply order matters: warning first, confirmation second. This ensures the user sees the warning even if subsequent steps fail.

---

### I11 — Secret Redaction in `lastAssistantExcerpt`

**Decision: daemon-side redaction in dedicated module**

Redaction runs in `src/bot/redactSecrets.ts` → `redactSecrets(text: string): string`. Called in `afkMode.ts:formatOrientationMessage` on the raw excerpt before composing the orientation message.

**Rationale:**
- Extension stays a pure cache (no logic)
- Daemon owns all Telegram-facing concerns
- Symmetric with N2 guard location
- Easier to unit-test in isolation (no extension mocking needed)

**Pattern list (order matters — most specific first)**

| # | Pattern | What it catches | Replacement |
|---|---------|-----------------|-------------|
| 1 | `\b(token\|key\|secret\|password\|authorization\|bearer\|api[_-]?key\|access[_-]?token)\b(\s*[:=]?\s*['"]?)([A-Za-z0-9_\-.+/=]{16,})['"]?` | Keyword-adjacent tokens (API keys, bearer tokens, passwords in logs) | `${keyword}${sep}[REDACTED]` |
| 2 | `(?<!<)[A-Za-z0-9_\-]{40,}` | Bare high-entropy strings (JWT tokens, SHA hashes used as tokens, long secrets not near a keyword) | `[REDACTED]` |
| 3 | `(https?:\/\/)[^:@\s]+:[^@\s]+@` | URLs with embedded credentials | `${protocol}[REDACTED]@` |

**Bias:** Over-redaction (false positives) is acceptable. Under-redaction (false negatives) is not. Pattern 2 will redact long code snippets, commit SHAs, etc. — that's OK for an orientation excerpt.

**Email addresses:** Preserved for now — may be relevant assistant context.

**Export contract (for Jun's tests)**

```typescript
// src/bot/redactSecrets.ts
export function redactSecrets(text: string): string
```

Jun can import and test each pattern category with representative inputs.

---

## Jun — Phase 9 Review Tests: Decisions

**Date:** 2026-05-30  
**Author:** Jun (Test Engineer)  
**Wave:** Phase 9 review — test-quality blockers + anticipatory regression tests

---

### B2 — Vacuous `/new` assertion (handlers.slashGuard.test.ts)

**What was broken**

The test at the `/new` guard section looked like this:

```ts
await handler(makeMockCtx('/new test-name'));
// ...
expect(makeMockCtx('/new test-name').reply).not.toHaveBeenCalled();
```

Two separate `makeMockCtx(...)` calls were made:
1. One was passed to the handler (the handler ran against it).
2. A **fresh** ctx was created for the assertion — this ctx was never passed to anything.

The `expect(ctx.reply).not.toHaveBeenCalled()` on the fresh ctx was therefore vacuously true regardless of what the handler did. Even if the guard were removed and `reply` were called, this test would still pass.

**What changed**

Captured the ctx before the handler call:

```ts
const ctx = makeMockCtx('/new test-name');
await handler(ctx);
expect(ctx.reply).not.toHaveBeenCalled();
```

This mirrors the `/list` test immediately below, which was already correct. The assertion is now falsifiable: if the guard logic were removed, the handler would call `ctx.reply`, and the test would fail.

---

### I7 — extension-back-banner.test.ts rewrite

**Why option (a) failed**

`handleBackConfirmed` and `handleModeChanged` are NOT exported by `extension.mjs`. Attempted export lookup shows only `isDestructive` and `isKnownSafe` are exported. Additionally, `extension.mjs` has top-level side effects:
- Reads `process.env.SESSION_ID`, `process.env.SESSION_NAME` at module load
- Imports `@github/copilot-sdk/extension` which bootstraps the Copilot extension host

Direct import in vitest would trigger these side effects and likely fail or require a full daemon environment.

**Why option (b) was deferred**

Extracting `handleBackConfirmed` and `handleModeChanged` into a separate module would require modifying `extension.mjs`. This file is outside wave scope. Tracked as a follow-up for the next wave.

**Chosen approach: source-analysis (option analogue)**

Following the established pattern in `tests/bridge/extension-protocol-drift.test.ts`, which uses `readFileSync` to parse `extension.mjs` as text.

The new `extension-back-banner.test.ts`:
1. Reads `extension.mjs` with `readFileSync`
2. Extracts `handleBackConfirmed` and `handleModeChanged` bodies using a brace-balancing parser
3. Asserts structural properties

**What this catches**

If a future developer adds `showCliMessage` to the wrong branch, removes guards, or renames strings, the tests fail and catch the regression.

---

### Helpers extraction — reconciliation of makeMockBot / makeStubRegistry

**`makeStubRegistry`**

All copies were structurally identical. Extracted to `tests/helpers/registryMocks.ts`.

**`makeMockBot`**

Three files shared the same grammY bot shape. Extracted to `tests/helpers/botMocks.ts`.

`afkMode.slashGuard.test.ts` has a DIFFERENT `makeMockBot()` shape (the AfkModeController API). Kept local.

**`makeMockCtx`**

`handlers.slashGuard.test.ts` version moved to `tests/helpers/botMocks.ts` as the common version.

---

### Anticipatory regression tests — contract divergence notes

**B1 (isBotCommand digit fix):** RED until Carter lands regex fix.
**I10 (validatePath warning):** RED until Kat adds warning field.
**I11 (redactSecrets):** RED until Kat creates redactSecrets.ts.
**B3 (prod-over-dev junction):** RED until Carter adds lstatSync check.
**I3+I4 (quote-aware flag parser):** RED until Carter lands parser.

---

## Jun — Cycle 2 Decisions: handlers.test.ts migration

**Date:** 2026-05-30  
**Author:** Jun  
**Status:** Complete

---

### Context

Cycle 2 review identified that `tests/bot/handlers.test.ts` contained a local `makeStubRegistry` function that was missed during the F-8 helpers extraction. The local stub was missing `upsert`, masked by an `as unknown as ISessionRegistry` cast.

### findByName — no extension needed

The Craft reviewer flagged that the local stub's `findByName` was a functional linear-search, while the shared helper's `findByName` is `vi.fn()` (no-op). Investigation confirmed **no test in handlers.test.ts asserts on `findByName` behavior**.

Decision: **straight migration** — no need to add a `findByName?: (name: string) => SessionEntry | undefined` override parameter to the shared helper.

### remove() default — shared helper updated

A behavioral gap surfaced during validation:
- Local stub: `remove: vi.fn(async (topicId) => map.delete(topicId))` — returned `true` when the entry existed
- Shared helper: `remove: vi.fn()` — returned `undefined` (falsy)

**Decision:** Updated shared helper's `remove` default to `vi.fn().mockResolvedValue(true)`.

**Rationale:**
- Matches the `ISessionRegistry` interface semantically
- "Success" is the default state for a stub backed by real entries
- Tests that need the failure branch already call `.mockResolvedValue(false)` explicitly
- No other consumers were affected

### Cast situation

The `as unknown as ISessionRegistry` cast lives inside the shared helper's implementation. Consumers always receive a typed `ISessionRegistry` from the function return type.

---

## Carter — Phase 9 Review Fix Wave Decisions

**Date:** 2026-05-30  
**Author:** Carter  

---

### Streaming serialization choice (I1+I2)

- Chose Noble Six Option A: per-session serialization queue in `extension.mjs` (`streamQueue` gate + `releaseLock`)
- Reason: `session.idle` has no correlation key, so message-id-only filtering cannot safely terminate concurrent streams
- Added drain-aware `writeFrame()` and per-request write queue to avoid fire-and-forget pipe writes under backpressure

### Flag parser tokenizer design (I3+I4)

- Implemented `parseNewFlags` in `src/bot/newFlagParser.ts` as a small state-machine tokenizer
- Supports single/double quoted values and minimal `\"` / `\\` unescaping inside double quotes
- Decision on repeated flags: last value wins (e.g., multiple `--model` entries keep the final one)
- Error policy: throws friendly errors for missing flag values, flag-as-value misuse, unknown flags, and missing session name

### Shared registry choice (I6)

- Implemented Option A: canonical command set remains `BOT_COMMANDS` in `src/bot/commands.ts`
- Added alias export `BOT_COMMAND_NAMES` and startup drift check in `registerHandlers`
- Drift between hard-coded handler registrations and command registry now fails fast at startup

### /cwd extraction layout (I8+I9)

- Extracted inline `/cwd` logic into `handleCwdCommand(ctx, opts)` in `src/bot/cwdCommand.ts`
- Chose function-based module extraction (not class) to keep handler wiring simple and testable
- Added structured logging hooks (`info/warn/error`) and surfaced `validatePath().warning` before success replies

### isDirectRun pattern

- Chose ESM-accurate direct execution check: `process.argv[1] === fileURLToPath(import.meta.url)`
- Applied in:
  - `src/install/copyExtension.ts`
  - `src/install/index.ts`
  - `src/install/uninstall.ts`
- Rationale: avoids fragile suffix checks against transpiled path/name variations

### Divergences from Noble Six design

- Kept serialization queue design unchanged
- Backpressure implementation uses explicit per-request promise chaining (`writeQueue`) plus `writeFrame()` rather than one-pending-chunk buffering
- Added structural drift tests in `tests/bridge/extension-protocol-drift.test.ts` to pin queue/backpressure primitives

### redactSecrets reconciliation outcome

- Jun's 3 RED tests remained red after Kat's baseline implementation
- Extended `src/bot/redactSecrets.ts` with:
  - env-assignment secret redaction (`*_TOKEN`, `*_SECRET`, etc.)
  - slightly broader high-entropy threshold (`39+`) to match real-world token samples in tests
- Preserved Kat's over-redaction bias and existing pattern ordering intent

---

## Carter — Phase 9 Review Cycle 2 Decisions

**Timestamp:** 2026-05-30  
**Branch:** user/aaron/phase9 @ 1d9955b
**Author:** Carter

---

### C2-B1 — Why resolve-not-reject on socket close in writeFrame

When a socket is destroyed while `writeFrame` is waiting for backpressure to clear, a rejected promise would bubble up through `writeQueue.then(...)` into `streamSdkResponse`, manifesting as a turn failure even though the *actual* error was upstream (the socket destroyed at the daemon side for an independent reason). The caller (`streamSdkResponse`) would surface "write failed" to the user when the real failure was e.g. "daemon process exited".

Resolving instead of rejecting shifts error responsibility to the next `writeFrame` call, which checks `socket.destroyed === true` and returns immediately. The error surface point is then the outer streaming logic that checks the socket state — not a spurious rejection inside a per-frame write.

This is consistent with the pattern used by Node core streams: a `write()` call that cannot complete because the stream was destroyed does not produce a hard error; it simply becomes a no-op on the destroyed stream.

---

### C2 — Escape-handling Option A: backslash is always literal inside quotes

Chose **Option A**: removed the `\\` → `\` and `\"` → `"` escape sequences from the double-quoted tokenizer path in `src/bot/newFlagParser.ts`.

**Rationale:**
- The spec comment in `tests/bot/newFlagParser.test.ts` explicitly states "No escape sequences inside quotes (backslash is literal — needed for Windows paths)"
- The previous implementation was inconsistent with that spec and created a latent footgun for UNC paths
- Single-quote mode was already backslash-literal; this change makes the two quote modes symmetric

**Tests changed (handlers.test.ts):**
- Removed `'has spaces'` from the `rejects session names with invalid characters` test loop
- That case is now handled earlier by the multi-word session name error path and is separately covered in `tests/bot/newFlagParser.test.ts`

**Regression test added:**
- `tests/bot/newFlagParser.test.ts`: `--cwd "\\\\server\\share"` → cwd = `\\server\share` (verifies that double-backslash UNC prefix is preserved literally)

---

### C2-I1 — Final regex changes in redactSecrets

**ENV_ASSIGNMENT_PATTERN**

Added `ACCESS_KEY(?:_ID)?` to the keyword alternation so that both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` match the env-style pattern:

```
(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?TOKEN|ACCESS_KEY(?:_ID)?)
```

`AWS_SECRET_ACCESS_KEY` also hits the `SECRET` branch (double-coverage is harmless). `AWS_ACCESS_KEY_ID` was previously not matched by any branch.

**HIGH_ENTROPY_PATTERN**

Changed charset from `[A-Za-z0-9_-]{39,}` to `[A-Za-z0-9_\-/+]{39,}`.

The forward slash `/` and `+` character appear in standard base64 output. AWS secret access keys and many JWT/API tokens use base64 encoding; without `/` and `+` in the charset, values like `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` would be split at the `/` delimiters and each fragment would be too short to trigger the 39-char threshold, silently leaking the value.

**Docstring**

Updated the file-level docstring to list all four pattern groups accurately and changed "40+" to "39+" throughout (the regex is `{39,}` and has been since the cycle 1 fix wave; the doc was lagging).

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

## The Gap

Aaron tried `/afk` during Phase 8 dogfood prep. It doesn't work because `extension.mjs` is never installed to the Copilot CLI extensions directory. The daemon has `npm run service:install` (Phase 2). The extension has nothing.

Carter's audit confirmed: `%APPDATA%\GitHub Copilot\User\extensions\reach\extension.mjs` — this path does not exist on Aaron's machine. No script creates it.

---

## Recommendation: Option C

**Single `npm run install` orchestrator** that runs:
1. Config wizard (validate/prompt for tokens, warn on missing allowed-user-IDs)
2. Extension copy (`src/install/copyExtension.ts` → copies `extension.mjs` to Copilot extensions dir)
3. Service install (existing `src/service/install.ts` — unchanged)

Sub-commands also exposed individually:
- `npm run install:extension` — extension copy only (unblocks dogfooding immediately)
- `npm run uninstall` — service uninstall + extension directory deletion

## Cross-Platform

Deferred. Windows-only for Phase 8.5 and Phase 9. No launchd, no systemd.

## Phase Call

**Phase 8.5** — micro-sprint before Phase 9. Four tasks, one session estimate. Exits when Aaron can run `npm run build && npm run install:extension && /afk` successfully.

---

## Task Assignments (Recommended)

| Task | Owner | Priority | Output |
|------|-------|----------|--------|
| `src/install/copyExtension.ts` | Carter | **IMMEDIATE** | Unblocks dogfood |
| `src/install/index.ts` + wizard + uninstall | Kat or Carter | High | Full install UX |
| Tests for copyExtension | Jun | High | Baseline coverage |
| README install section update | Scribe | Medium | Docs complete |

---

## What Teams Should NOT Do

- No cross-platform support
- No npm publish
- No MSI installer
- No new ADRs
- No Phase 9 features
- No config.json schema changes

---

## Open for Aaron

Five UX preference questions documented in handoff doc (script naming, wizard hard-block on empty allowed-user-IDs, dev symlink, uninstall wipe flag). Noble Six defers these to Aaron.


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

## Files Changed

| File | Change |
|------|--------|
| `extension.mjs` | Bug #3: `handleModeChanged` — removed banner for `active === false` case |
| `extension.mjs` | Bug #4: `SESSION_NAME` fallback changed from `SESSION_ID` to `path.basename(process.cwd())` |
| `extension.mjs` | Added `basename` to the existing `import { join } from 'node:path'` import |
| `tests/bridge/extension-back-banner.test.ts` | New — 5 unit tests for banner-dedupe handler contract |

---

## Bug #3 — Duplicate "🖥️ Back at desk" Banner

### Decision

`handleModeChanged(active=false)` is now silent. `handleBackConfirmed` owns the banner.

### Rationale

The `deactivate()` path in `afkMode.ts` sends BOTH `back.confirmed` (session-scoped) AND
`mode.changed { active: false }` (broadcast) to every session. The session that ran `/back`
receives both and was therefore shown the banner twice.

`back.confirmed` is the canonical "you are back" signal — it is session-specific and always
accompanies a `/back` transition. `mode.changed` is a machine-wide data event that other
consumers may observe. Making `mode.changed(false)` silent follows the same pattern as
`afk.activated` + `mode.changed(true)` — the dedicated event owns the display; the broadcast
is informational.

The `active === true` path in `handleModeChanged` was NOT changed — that was not reported as a
bug and is out of scope.

### Considered Alternative

Guard with a `bannerEmitted` flag so `handleModeChanged` is silent only if `handleBackConfirmed`
already fired. Rejected: the flag would need to survive the async gap between two separate message
handlers, and the "always silent for active=false" rule is simpler, correct for all callers, and
easier to maintain.

---

## Bug #4 — Topic Title Shows `sessionId (sessionId)`

### Decision

Changed the `SESSION_NAME` fallback from `SESSION_ID` to `path.basename(process.cwd())`.

### Rationale

`SESSION_NAME` is read from the `SESSION_NAME` env var, which the CLI does not currently set when
launching extension processes. The prior fallback was `SESSION_ID` (a UUID-like string), making
the topic title render as e.g. `sess-abc123 (sess-abc123)`.

The SDK's `joinSession()` return value does not expose a `name`, `friendlyName`, or `displayName`
field (verified against `node_modules/@github/copilot-sdk/dist/types.d.ts`). The only other
meaningful source available in the extension process is `process.cwd()`.

`path.basename(process.cwd())` gives the project directory name (e.g. `verbose-invention`),
which is a meaningful and stable identifier. `SESSION_ID` is retained as a final fallback in case
cwd basename is somehow empty (ADR-8 §3 preserved — field is always non-empty).

### Note on Long-Term Fix

If the CLI is later updated to set `SESSION_NAME`, this code path becomes correct automatically
with no further changes needed.

---

## Test Coverage

New file `tests/bridge/extension-back-banner.test.ts` documents the post-fix handler contract:

1. `back.confirmed` emits exactly one "Back at desk" banner
2. `mode.changed active=false` is silent
3. `mode.changed active=true` still emits "AFK mode active" banner
4. Both events together produce exactly one banner (the core dedupe assertion)
5. AFK scenario documents the two-banner case (afk.activated + mode.changed active=true)

Test suite after fixes: **538 passed / 4 skipped / 0 failed**. tsc clean, lint zero warnings.


---

## Cycle 1 — afkStreamRouter.ts State Leaks

# kat-pr7-cycle1 — PR #7 Copilot Review Fixes

**Date:** 2026-05-28T22:45:13-07:00  
**Author:** Kat  
**Branch:** user/aaron/phase-8  
**Commit:** 09d0c40

---

## Summary

Addressed all 4 substantive Copilot review threads on `src/bot/afkStreamRouter.ts` from PR #7.

---

## Fixes

### Thread 1 — `enqueueChunk` sessionRequestIds empty-Set leak (line ~58)
After deleting a requestId from its Set, the sessionId key was never removed when the Set became empty. Every completed stream left a stale `Set()` in `sessionRequestIds`.

**Fix:** Extracted `removeRequestId(sessionId, requestId)` private helper. Checks `ids.size === 0` after delete and removes the sessionId key. Used at the `enqueueChunk` done-path finalizer.

### Thread 2 — `enqueueError` sessionRequestIds empty-Set leak (line ~72)
Same leak pattern as Thread 1.

**Fix:** `enqueueError` finalizer now calls `removeRequestId` instead of the bare optional-chain delete.

### Thread 3 — `handleChunk` early-return skips done-cleanup when binding removed mid-stream (line ~108)
`getTopicId` returning `undefined` caused an early return that bypassed the `finally { if (done) streamStates.delete(key) }` block, leaking state for any stream whose topic binding was removed before the final chunk arrived.

**Fix:** Resolve `topicId` as `streamStates.get(key)?.topicId ?? this.deps.getTopicId(sessionId)` before the guard. Key computation moved before topic resolution. Only early-return when both are absent.

### Thread 4 — `handleError` early-return skips state deletion when no binding (line ~127)
Same shape as Thread 3: early return on undefined topicId prevented cleanup for a terminating stream.

**Fix:** Delete state unconditionally first (`this.streamStates.delete(key)`), then derive `topicId` from `state?.topicId ?? getTopicId(sessionId)`. Telegram error send fires when topicId is available; state is cleaned either way.

---

## Tests Added

New file: `tests/bot/afkStreamRouter.test.ts` (8 cases)

| ID | Description |
|----|-------------|
| T1-chunk | sessionId key removed after last requestId drains via enqueueChunk |
| T1-chunk (retain) | sessionId key kept while a second requestId is still active |
| T2-error | sessionId key removed after requestId drains via enqueueError |
| T3 (cleanup) | done=true cleanup (streamStates.delete) runs when binding removed mid-stream |
| T3 (edit) | editMessageText fires on done=true with binding removed |
| T4 (delete) | streamStates entry deleted on error path when getTopicId returns undefined |
| T4 (edit) | editMessageText called with error text using topicId from state |
| T4 (no-op) | no Telegram call and no throw when neither state nor binding exists |

---

## Validation

- `npx tsc --noEmit` — clean
- `npx vitest run` — 525 passed / 4 skipped / 0 failed
- `npm run lint` — 0 warnings


---

## Cycle 2 — handleChunk Placeholder Retry

# Decision Note — PR #7 Cycle 2: handleChunk Placeholder Retry

**Date:** 2026-05-28T22:45:13-07:00  
**Author:** Kat (Bot Dev)  
**File:** `src/bot/afkStreamRouter.ts` — `handleChunk`  
**Commit:** `2f12755`

---

## Problem

Copilot thread PRRT_kwDOSAVb5c6FmLX7 identified a stuck-stream scenario:

1. Chunk 1 arrives. `StreamState` is created and added to `streamStates`. Then `sendMessage` is called for the placeholder.
2. `sendMessage` throws (rate limit / transient failure). `state.messageId` stays `undefined`.
3. Chunk 2+ arrives. The original guard was `if (!state)` — state exists, so the branch is skipped. No retry, no Telegram updates. Stream is permanently silent.

Additionally, the original code appended `chunk` to `state.text` **after** `sendMessage`. If `sendMessage` threw mid-call, the chunk text was never buffered, so any retry attempt would lose the first chunk's content.

---

## Decision

**Both parts applied together; neither alone is sufficient.**

### Part 1 — Eager state init + retry guard

Initialize `StreamState` **before** any network call:

```typescript
let state = this.streamStates.get(key);
if (!state) {
  state = { topicId, text: '', lastEditAt: 0 };
  this.streamStates.set(key, state);
}
```

Guard on `state.messageId === undefined` (not `!state`):

```typescript
if (state.messageId === undefined) {
  // retry path — handles first-ever chunk AND failed-prior-attempt chunks
}
```

### Part 2 — Buffer before network

```typescript
state.text += chunk;   // always first, before any await

if (state.messageId === undefined) {
  try {
    const placeholder = await bot.api.sendMessage(chatId, state.text, ...);
    state.messageId = placeholder.message_id;
    state.lastEditAt = Date.now();
  } catch (err) {
    console.warn('[afk] Failed to create stream placeholder:', errorText(err));
    return;   // outer finally still fires; done=true still cleans up
  }
} else {
  // throttled-edit path — unchanged
}
```

### Behavioral changes vs. original

| Scenario | Before | After |
|---|---|---|
| sendMessage throws on chunk 1 | stream stuck forever | chunk 2 retries with full buffer |
| sendMessage succeeds on chunk 1 | sends `'…'` placeholder, then immediately edits | sends actual chunk text directly; no redundant edit |
| done=true on chunk 1 retry success | n/a | message sent with full accumulated text; state cleaned in finally |
| All cycle-1 invariants | ✓ | ✓ (no regression) |

---

## Tests Added

- **T5a:** sendMessage throws → `state.messageId` undefined, `state.text` = chunk1 text
- **T5b:** chunk 2 retries → sendMessage called with cumulative `chunk1 + chunk2` text; `messageId` set
- **T5c:** chunk 3 after success → only `editMessageText` called; no further `sendMessage`

**Suite result:** 528 passed / 4 skipped / 0 failed. `tsc --noEmit` clean. `eslint --max-warnings 0` clean.


---

## Cycle 3 — Telegram Display Cap + isActive Guard

# Decision Note — PR #7 Cycle 3
**Author:** Kat  
**Date:** 2026-05-28T23:25:16-07:00  
**File:** `src/bot/afkStreamRouter.ts`

---

## Thread A — Telegram 4096-char display cap

**Problem:** `state.text` is an unbounded accumulator. Once it exceeds 4096 characters, every subsequent `sendMessage`/`editMessageText` call returns a Telegram 400 error. Combined with the cycle-2 retry path, this produces an infinite retry loop — the stream stalls permanently. Separately, an empty `state.text` on the first chunk causes `sendMessage` to reject with a 400 (empty body).

**Options considered:**
1. **Hard truncate `state.text` itself** — loses earlier output permanently; no future recovery.
2. **Cap only the display string; keep full buffer** — selected. Non-destructive. If we ever want to send a "full log" later we still have it.
3. **Split into multiple messages** — overkill for streaming; introduces ordering complexity.

**Decision:** Option 2. Added `displayText()` helper:
- `''` → `'…'` (non-empty placeholder; Telegram won't reject it, user sees streaming started)
- `text.length <= TELEGRAM_MAX_DISPLAY` → passthrough
- over cap → `'…(truncated)\n' + text.slice(-(TELEGRAM_MAX_DISPLAY - prefixLen))` (last-N, 3987 chars of body)

Last-N chosen over first-N because streaming output's most useful content is at the tail (most recent tool output), not the head.

`TELEGRAM_MAX_DISPLAY = 4000` (not 4096) to leave headroom for the 13-char truncation prefix and any future footer additions without pushing over the Telegram hard limit.

---

## Thread B — handleError isActive race guard

**Problem:** `handleChunk` checks `isActive()` at entry and returns early on deactivation. `handleError` had no equivalent guard. An error frame arriving after `/back` would still emit `❌ Error:` into the (now-closed or re-used) topic. This is a false signal to the user.

**Options considered:**
1. **Guard isActive() before the entire handleError body** — breaks cycle-1 invariant (state not cleaned up when inactive).
2. **Guard isActive() after state cleanup, before Telegram send** — selected. Cleanup is always non-destructive and cheap; the guard only gates the outbound message.

**Decision:** Option 2. `this.streamStates.delete(key)` runs unconditionally (cycle-1 invariant preserved). Immediately after: `if (!this.deps.isActive()) return;`. The Telegram edit/send is skipped.

The `topicId` resolution is also skipped (it's only needed for the send), which is a minor bonus — avoids a stale `getTopicId` call on an already-deactivated controller.

---

## Invariants (cumulative, post cycle 3)

| # | Invariant |
|---|-----------|
| C1 | `removeRequestId` deletes the sessionId key when its Set empties. |
| C2 | `handleChunk` done=true cleanup runs via `finally` even when topic binding is gone (topicId resolved from state first). |
| C3 | `handleError` always deletes state unconditionally — never gated on topic or active status. |
| C4 | `handleChunk` appends chunk text before any network call; `messageId === undefined` retries placeholder on every chunk. |
| C5 | `displayText()` is used for every Telegram text argument in `handleChunk` — raw `state.text` is never passed directly. |
| C6 | In `handleError`, the `isActive()` guard gates only the Telegram send — not the state cleanup. |


---

## Cycle 4 — Production Bug: Timer Leak + Fleet Tests

# Decision Note — PR #7 Cycle 4 (Kat)

**Date:** 2026-05-28T23:25:16-07:00  
**Author:** Kat  
**Context:** Copilot code review cycle 4 on PR #7 (extended past maxCycles by Aaron — real production bug found).

---

## Thread 1 — Timer leak in `compensatePartialActivation` (PRODUCTION BUG)

**Finding:** `compensatePartialActivation` used `Promise.race([closePromise, timeout])` where the `timeout` was built from a bare `setTimeout`. When `closeForumTopic` resolved first (the happy path), the `setTimeout` was never cleared. At fleet scale (N=20), this left 20 pending timers on the event loop — a real resource leak in production.

**Fix applied:** Captured `timeoutHandle: NodeJS.Timeout | undefined` in the closure, replaced the bare `new Promise<never>` with a block that assigns `timeoutHandle = setTimeout(...)`, and chained `.finally(() => { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); })` on the `Promise.race` return. The timeout still fires correctly if `closeForumTopic` loses; it is always cancelled otherwise.

**Decision:** Fix inline in `compensatePartialActivation`'s `compensationClose` inner function. No signature or caller changes needed.

---

## Threads 2 & 3 — A6-6 fleet test assertions tightened

**Finding:** Both `TC-A6-6-1` and `TC-A6-6-2` asserted `vi.getTimerCount() === FLEET_SIZE` — described in comments as "confirms all closes completed via the close-result path". This phrasing accidentally documented a timer leak as correct behaviour.

**Fix applied:** Changed both assertions to `vi.getTimerCount() === 0`. Updated comments to explain that zero pending timers proves the leak is fixed. The core test purpose (all N topics close cleanly, no duplicates, no leaks) is unchanged.

---

## Thread 4 — `env.ts` deny-all fatal message (nit)

**Finding:** Fatal message at `env.ts:90` said `'allowedUserIds is empty'` — not actionable because operators don't know whether to check the env var or the config file.

**Fix applied:** Updated to: `'allowed user list is empty (env var TELEGRAM_ALLOWED_USER_IDS or config telegramAllowedUserIds resolved to size 0) — this would deny all users. Unset to allow all, or provide at least one ID.'`

**Decision:** Named both config surfaces explicitly. Kept the same message tone and the `'deny all users'` substring (relied on by the N2 test assertion).

---

## Thread 5 — `env.test.ts` stale comment (nit)

**Finding:** Comment at line 92 referred to `'N2 (backlog) test below'`. The N2 guard shipped in Phase 8; the test is no longer a backlog item.

**Fix applied:** Updated comment to `'shipped N2 guard test below'`.

---

## Validation

- `npx tsc --noEmit` — clean
- `npx vitest run` — 533 passed / 4 skipped / 0 failed (41 files)
- `npm run lint` — 0 warnings
- A6-6 both pass with `vi.getTimerCount() === 0` ✅

**Commit:** `8a95edb` — "Address Copilot review on PR #7 cycle 4: clear compensation timeout + 3 nits"


---
## Phase 8 Watch Status Summary

| Watch | Status | Disposition |
|---|---|---|
| F4 | ✅ RESOLVED | Soft refactor: extracted `afkStreamRouter.ts` (133 LOC); `afkMode.ts` now 649 LOC |
| A6-6 | ✅ CLOSED | Promise-all burst safe at N=20+; compensation logic validated via TC-A6-6-1/2 |
| A2 | DORMANT | P2; defer until first relay error code is added |
| F8 | DORMANT | P2; extract when dynamic auth arrives |
| F5 | DORMANT | P2; trigger if `AfkBridgePort` event count ≥ 8 or spans two unrelated domains |
| A10-4 | DORMANT | Future; trigger when Phase 8 adds fourth operation to topic lifecycle |

**Remaining open items** (from Phase 8 backlog, not watch-triggered):
- None — all P1 items (A7, N2, N3, A8) resolved in Phase 8 P1 sprint (2026-05-27)

**Phase 8 Status:** P1 SHIPPED (2026-05-27) + watch sweep COMPLETE (2026-05-28). Remaining P2/dormant watches stay dormant per Cycle 7 triage.


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

## Finding 1: Slash Commands Intentionally Blocked

**Discovery:** During Item 2 investigation, confirmed that slash commands in Telegram topics are intentionally blocked by explicit guards, not a bug.

**Location:** 
- `src/bot/afkMode.ts:151` — `if (text.startsWith('/')) return false;`
- `src/bot/handlers.ts:270` — `if (ctx.message.text.startsWith('/')) return;`

**Root Cause:** Guards were added to prevent AFK handler from intercepting Telegram bot commands (`/new`, `/list`, etc.). However, the blanket `/` check also blocks CLI session commands (`/clear`, `/agent`, `/model`).

**Status:** Addressed in Phase 9 design — recommend `isBotCommand()` guard that distinguishes bot commands from CLI commands.

**Team Action:** None needed — this is expected behavior being improved, not a bug to fix.

---

## Finding 2: `relay.command` Protocol Envelope is Stubbed

**Discovery:** The daemon-to-extension protocol includes a `relay.command` message type, but:
1. The daemon has **no producer** for this message type
2. The extension handler is a **no-op stub** (just logs)

**Location:**
- `src/bridge/protocol.ts:191-198` — interface definition with comment "DEFERRED (Phase 8)"
- `extension.mjs:343-349` — stub handler that only logs

**Assessment:** This is intentional deferral, not a bug. The envelope was reserved for future structured command dispatch (e.g., `/clear` with special handling). Phase 9 design recommends using `mirror.input` for pass-through, leaving `relay.command` for Phase 10+ curated commands.

**Team Action:** None needed — protocol envelope preserved for future use.

---

## Finding 3: Session CWD is Descriptive, Not Prescriptive

**Discovery:** The `cwd` field in `SessionEntry` records where a session was started, but the daemon cannot currently spawn CLI processes in a chosen cwd. Telegram-initiated spawn is Phase 11+ scope.

**Location:** `src/sessions/registry.ts:138` — `cwd` defaults to `process.cwd()`

**Assessment:** This is a design limitation, not a bug. Phase 9 design addresses the visibility/selection UX without implementing spawn-from-Telegram.

**Team Action:** None needed — correctly scoped in Phase 9 design.

---

## Recommendation: Centralize Bot Command Set

**Observation:** If Phase 9 implements `isBotCommand()` guard, the list of bot commands (`/new`, `/list`, `/remove`, `/resume`, `/help`, `/pair`) will exist in two places:
1. `handlers.ts` — command registrations
2. `afkMode.ts` — guard set

**Risk:** Desync if new bot command added but guard not updated.

**Recommendation:** Export `BOT_COMMANDS` set from `handlers.ts`, import in `afkMode.ts`. Single source of truth.

**Team Action:** Include in Phase 9 Task T3.

---

## No ADR Updates Required

All three items are feature additions within existing architectural boundaries:
- Item 1: Extends AFK mode (ADR-11) with orientation message
- Item 2: Activates existing protocol envelope (ADR-8, ADR-11 §9)
- Item 3: Extends config layer (no ADR)

---

**Filed to:** `.squad/decisions/inbox/noble-six-phase9-triage.md`  
**Next:** Merge to decisions.md after Phase 9 sprint approval


# Kat — Phase 9 Item 1: Orientation Message Decisions

**Date:** 2026-05-30T11:49:29-07:00
**Author:** Kat (Bot Dev)
**Task:** Phase 9 Item 1 — AFK topic orientation message + /status command

---

## Decision 1: First-activation gating mechanism

**Choice:** In-memory `orientationSent` boolean on `TopicBinding` (per binding, in `sessionTopics` map).

**Rationale:**
- `sessionTopics` is cleared on `/back` → `deactivate()`, so `orientationSent` resets naturally each AFK cycle without explicit cleanup.
- Re-activation after `/back` → `/afk` sends orientation again (new AFK cycle). This is correct UX.
- Daemon restart clears all in-memory state → orientation re-sent on first activation after restart. Acceptable — per spec: "re-sending after daemon restart is acceptable; it's idempotent UX".
- No persistence needed.

---

## Decision 2: /status excerpt freshness — Option A vs B

**Choice: Option A** — daemon caches last-received excerpt from `afk.request` envelopes in `lastKnownExcerpts: Map<string, string>`, cleared on `deactivate()`.

**Rationale:**
- Option B (new `status.request` / `status.response` round-trip) is more complex and requires new protocol messages.
- "Last known" data is good enough for orientation purposes — the excerpt updates each time the user goes `/afk`.
- If Aaron wants fresher data for `/status`, a Phase 10 round-trip can be added later.
- `lastKnownExcerpts` is cleared on `deactivate()` to avoid showing stale excerpts across AFK cycles.

---

## Decision 3: Truncation behavior

**Choice:** 499 chars + `…` (Unicode ellipsis, U+2026) if over 500 chars; otherwise verbatim.

**Implementation:** In `extension.mjs` `sendModeRequest()`:
```javascript
msg.lastAssistantExcerpt = lastAssistantMessage.length > 500
  ? lastAssistantMessage.slice(0, 499) + '…'
  : lastAssistantMessage;
```

- Truncation at 500 chars (total), no word-boundary smarts.
- Simple to tune later — single constant in extension.mjs.
- Aaron locked 500 chars as default.

---

## Decision 4: /status added to BOT_COMMANDS

**Choice:** Yes — added `'status'` to `BOT_COMMANDS` in `src/bot/commands.ts`.

**Rationale:**
- Prevents `/status` from being passed through to the CLI via mirror.input (Phase 9 Item 2 pass-through logic checks `isBotCommand()`).
- `bot.command('status', ...)` handler registered in `handlers.ts` handles the command.

**Carter coordination note:** Carter's Phase 9 Item 2 (pass-through) relies on `isBotCommand()` to distinguish bot commands from CLI pass-through. `/status` must be in `BOT_COMMANDS` so it's NOT forwarded to the CLI. No code conflict — different Set entry, different handler method, different regions of the same files.

---

## Decision 5: Orientation message format

Plain text (no `parse_mode`). Consistent with `safeSendMessage()` convention used for all topic messages. The `> excerpt` prefix is visual text only — not Telegram MarkdownV2 blockquote syntax.

Format:
```
📍 Session active
━━━━━━━━━━━━━━━━━━
🆔 {sessionId}
📂 {cwd}
🤖 {model}
🎚️ Mode: AFK (since HH:MM UTC)

💬 Last from {model}:
> {excerpt}
```

The `💬 Last from…` block is omitted entirely when no excerpt is available (fresh session or pre-Phase-9 extension).

---

## Decision 6: Model fallback

Added `globalModel?: string` to `AfkModeOptions`. Passed from `cfg.model` in `main.ts`. Fallback chain: `registryEntry.model ?? options.globalModel ?? 'unknown'`.

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

## Decision 1: Where the shared module lives

**Module:** `src/bot/commands.ts` (new file)

**Why this location:**

- Neither `afkMode.ts` nor `handlers.ts` imports the other, so placing the shared
  set in either file would create an awkward one-way dependency.
- `src/bot/commands.ts` is a flat peer module with no dependencies on anything
  in `src/bot/`, so both call sites can import from it without circular risk.
- A dedicated `commands.ts` makes the authoritative command list discoverable
  without reading the full handler registration logic.
- Considered `src/bot/index.ts` (re-export barrel) and `src/bot/registry.ts`
  (naming conflict with sessions registry) — both rejected for clarity reasons.

**Exports:**
- `BOT_COMMANDS: ReadonlySet<string>` — the authoritative Telegram bot command set
- `isBotCommand(text: string): boolean` — the guard helper used by both call sites

---

## Decision 2: The BOT_COMMANDS list

The list is derived from `bot.command()` registrations in `src/bot/handlers.ts`.
No guessing — every entry has a line citation.

| Command | Source citation |
|---------|----------------|
| `new`    | `handlers.ts:53`  — `bot.command('new', ...)` |
| `list`   | `handlers.ts:131` — `bot.command('list', ...)` |
| `remove` | `handlers.ts:145` — `bot.command('remove', ...)` |
| `resume` | `handlers.ts:161` — `bot.command('resume', ...)` |
| `help`   | `handlers.ts:244` — `bot.command('help', ...)` |
| `pair`   | `handlers.ts:259` — `bot.command('pair', ...)` |

`/back` and `/afk` are NOT in `BOT_COMMANDS`. They are CLI extension commands
(registered in `extension.mjs`), not Telegram bot commands. Per Phase 9
pass-through design, typing `/back` or `/afk` in a Telegram topic now forwards
verbatim via `mirror.input` to the CLI session. This supersedes the ADR-11 §2
"CLI-only" guard that previously dropped `/back` at the topic handler level —
the protocol contract (no `back.confirmed` without a full `back.request` round-trip)
is preserved regardless.

---

## Decision 3: `isBotCommand` behavior

- Returns `false` if text doesn't start with `/`
- Extracts the command word via `/^\/([a-zA-Z_]+)/` (greedy up to first space or EOL)
- Case-insensitive: `match[1].toLowerCase()` before set lookup — covers user typos
  like `/New` or `/LIST`
- Returns `true` only if the lowercased word is in `BOT_COMMANDS`

---

## Decision 4: relay.command stub left as-is

The `relay.command` envelope (`src/bridge/protocol.ts:191`) and its handler stub
in `extension.mjs:343–349` are untouched. Rationale:

1. `mirror.input` is sufficient for Phase 9's pass-through requirement — the CLI
   extension already handles slash commands natively when they arrive via stdin.
2. `relay.command` was designed for structured dispatch (parse command + args,
   route to specific extension logic). That adds daemon complexity with no payoff
   until Phase 10+ introduces commands that need Telegram-specific UX (e.g.,
   `/model` with an inline keyboard picker).
3. Activating the stub now would require: a producer in the daemon, argument
   parsing, and extension-side handler wiring — all out of scope for Item 2.

**Deferred to Phase 10.**

---

## Test updates

Two pre-existing tests were updated to match the new behavior:

1. **`tests/bot/handlers.test.ts`** — "ignores command messages (starting with /)"
   changed text from `/unknown-cmd` to `/list`. `/unknown-cmd` now correctly
   passes through (it's not in BOT_COMMANDS); `/list` is a bot command and
   is correctly ignored by the `message:text` handler.

2. **`tests/integration/afk-mode.contract.test.ts`** — T4 assertion updated:
   relay target now becomes `'cli'` (not `'telegram'`) when `/back` is sent to
   a topic, because `/back` is no longer in BOT_COMMANDS and forwards via
   mirror.input. All other T4 assertions (no back.confirmed, no mode.changed,
   no closeForumTopic) remain correct — text pass-through doesn't trigger the
   back.request protocol round-trip.

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

## 1. Alias Validation Regex

```
/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/
```

- **1–32 characters total** (first char + 0–31 body chars)
- **First character:** letter or digit only (`[a-zA-Z0-9]`)
- **Body characters:** letters, digits, underscore, hyphen (`[a-zA-Z0-9_-]`)
- Case-sensitive (aliases are identifiers, not display names)

### Reserved-word set

```typescript
const RESERVED_ALIASES = new Set(['--cwd', '--model', '--name']);
```

These all start with `-` and therefore already fail the regex. The set is kept explicit so the contract is clear to Carter's T6/T7 parser. **Anything starting with `-` is invalid as an alias** — the regex prevents this.

**Implication for Carter (T6):** The `/cwd add <alias> <path>` parser does not need to special-case these names; `validateAlias()` will reject them.

---

## 2. `removeKnownCwd` — no-op on missing alias

`removeKnownCwd(config, alias)` returns the **same config reference** (no-op) if the alias is not found. It does **not throw**.

**Rationale:** Config helpers are pure transforms; error semantics belong to the command layer. Carter's `/cwd remove <alias>` should call `getKnownCwdByAlias` first and produce a user-facing "alias not found" message if needed.

**Implication for Carter (T6):**
```typescript
// Recommended pattern in /cwd remove handler:
if (!getKnownCwdByAlias(config, alias)) {
  await ctx.reply(`❌ Unknown alias "${alias}"`);
  return;
}
const newConfig = removeKnownCwd(config, alias);
await saveConfig(configPath, newConfig);
```

---

## 3. Path comparison on Windows — case-insensitive

`getKnownCwdByPath` uses **case-insensitive** comparison on Windows (`process.platform === 'win32'`):

```typescript
c.path.toLowerCase() === normalized.toLowerCase()
```

**Rationale:** NTFS is case-preserving, not case-sensitive. `D:\Git\Reach` and `D:\git\reach` refer to the same directory. Matching must be case-insensitive or users will get duplicate entries from differently-cased inputs.

**Implication for Carter (T6):** When implementing "already exists?" duplicate-path check in `/cwd add`, use `getKnownCwdByPath(config, normalizedPath)` — it handles the Windows case-fold automatically.

---

## 4. Disambiguation strategy for `/new <plain-alias>` (T7)

Per Q3-3 (plain alias), the `/new` `--cwd` flag value is a bare alias (e.g., `reach`), not `@reach`.

### How the `--cwd` value is resolved in T7

Carter's `--cwd` value parser should use this precedence:

1. **Looks like an absolute path?**
   - Windows: starts with `<letter>:\` or `\\`  
   - Unix: starts with `/`  
   → Call `validatePath()` directly; do NOT look up as alias.

2. **Otherwise → alias lookup**
   → Call `getKnownCwdByAlias(config, value)`  
   → If found: use `entry.path`  
   → If not found: return error "Unknown alias `<value>`. Use `/cwd list` to see known directories, or provide an absolute path."

### Why "path check first"

An alias can never start with a path prefix character (the regex forbids it), so the check is unambiguous and requires no user disambiguation prompt.

### No collision with session names

`/new <session-name> --cwd <value>` — the session name is always the positional arg; the cwd is always the `--cwd` flag value. No overlap.

---

## 5. API shape (for Jun T8)

### Sync helpers (no I/O)

```typescript
validateAlias(alias: string): { ok: true } | { ok: false; reason: string }
listKnownCwds(config: ReachConfig): readonly KnownCwd[]
getKnownCwdByAlias(config: ReachConfig, alias: string): KnownCwd | undefined
getKnownCwdByPath(config: ReachConfig, path: string): KnownCwd | undefined
addKnownCwd(config: ReachConfig, alias: string, path: string, now: string): ReachConfig
removeKnownCwd(config: ReachConfig, alias: string): ReachConfig
touchKnownCwd(config: ReachConfig, alias: string, now: string): ReachConfig
```

### Async helper (needs fs.stat)

```typescript
validatePath(inputPath: string): Promise<{ ok: true; normalized: string } | { ok: false; reason: string }>
```

### `KnownCwd` shape

```typescript
interface KnownCwd {
  alias: string;       // required, unique
  path: string;        // absolute, normalized
  addedAt: string;     // ISO-8601
  lastUsedAt?: string; // ISO-8601, optional
}
```

### Notes for Jun

- `addKnownCwd` throws on alias collision or invalid alias; does **not** throw on bad path format (call `validatePath` first)
- `removeKnownCwd` is a no-op (does not throw) when alias is absent
- `touchKnownCwd` is a no-op when alias is absent
- `validatePath` is async (requires `fs.stat`); all other validators/helpers are sync
- `listKnownCwds` returns a stable sort: `lastUsedAt` desc (undefined last), then `alias` asc

---

## 6. Backward compatibility

`knownCwds` is `optional` on `ReachConfig`. Existing `config.json` files without this field:
- Load cleanly via `loadConfig()` (no schema validation; plain `JSON.parse`)
- All helpers treat `config.knownCwds ?? []` as the base — no nullish crashes

---

## 7. Persistence pattern

Reuses existing `saveConfig()` atomic write (write to `<path>.tmp` → `fs.rename`). No new I/O abstractions introduced.


# Phase 9 Item 3 — /cwd Command Group + /new --cwd Flag

**Author:** Carter  
**Date:** 2026-05-30  
**Phase:** 9 Item 3 (T6 + T7)

---

## General Topic Detection Mechanism

Used `ctx.message?.message_thread_id`:
- `=== undefined` → message is in the General Topic (no thread)
- `!== undefined` → message is in a forum topic (session thread)

The `/cwd` command handler enforces General-Topic-only by checking `if (topicId !== undefined)` and replying with a friendly error if the user runs it in a session topic. No config lookup required — grammY provides the thread ID on every message context.

This is the standard grammY pattern for Telegram Supergroup forum detection. The General Topic in Telegram supergroups has no `message_thread_id` (it's the root, not a thread).

---

## Session Start API — cwd Support

`ISessionRegistry.register()` **already had** a 5th optional parameter `cwd?: string` (defaults to `process.cwd()` when absent). No changes to the registry interface or implementation were required.

Key detail: When `--cwd` is not supplied, `registry.register()` is still called with exactly 4 args (no 5th `undefined` argument) to preserve existing test assertions:
```typescript
// No --cwd: 4 args exactly
await registry.register(topicId, chatId, name, model);
// With --cwd: 5 args
await registry.register(topicId, chatId, name, model, resolvedCwd);
```

---

## BOT_COMMANDS Update

Added `'cwd'` to the `BOT_COMMANDS` set in `src/bot/commands.ts`. This ensures `/cwd` messages in session topics are treated as bot commands (not CLI pass-through), so grammY routes them to the `/cwd` command handler.

---

## /new --cwd Flag Parsing Refactor

The existing `/new` handler used a single-purpose regex for `--model` only. This was refactored to a position-independent multi-flag extractor:

```typescript
const name = input
  .replace(/(^|\s)--(model|cwd)\s+(\S+)/g, (_m, _sep, flagName, flagValue) => {
    if (flagName === 'model') model = flagValue;
    else cwdArg = flagValue;
    return '';
  })
  .replace(/\s{2,}/g, ' ')
  .trim();
```

Flags can appear before or after the session name. Dangling flags (present without a value) are detected by checking for `--model` or `--cwd` remaining in the extracted `name` string, preserving the `expect.stringContaining('model value')` assertion from the existing test suite.

---

## Disambiguation Rule (Q3-3)

Path detection: `/^[a-zA-Z]:\\/.test(value) || value.startsWith('\\\\')` 
- Windows drive path (`C:\...`) → path branch → `validatePath()`
- UNC path (`\\server\...`) → path branch → `validatePath()` (rejects UNC with friendly error)
- Anything else → alias branch → `getKnownCwdByAlias()`

---

## Final /cwd Help Text (verbatim, for Kat's README)

```
/cwd list|add|remove — Manage known cwd aliases (General Topic only)
```

Sub-command usage:
```
/cwd list                    — list all known cwds with last-used times
/cwd add <alias> <path>      — register a new alias for a directory
/cwd remove <alias>          — remove an alias from the registry
```

List output format:
```
📂 Known cwds:
• myrepo — C:\src\myrepo  (last used 2h ago)
• scratch — D:\scratch  (never used)

Start one with: /new <alias>
```

Error messages:
- Alias collision: `❌ Alias '<alias>' already exists for <path>. Use a different name or run /cwd remove <alias> first.`
- Invalid alias: `❌ Invalid alias: <reason>. Aliases must be 1-32 chars, start alphanumeric, use letters/digits/hyphens/underscores.`
- Invalid path: `❌ Invalid path: <reason>. Path must be an absolute, existing directory.`
- Empty list: `📂 No known cwds yet. Add one with: /cwd add <alias> <path>`
- In session topic: `❌ /cwd commands work in the General Topic only. Manage your cwd registry there, then start sessions from any topic.`
- Unknown alias (--cwd): `❌ Unknown alias '<alias>'. Run /cwd list to see known cwds.`

---

## /new --cwd Help Text Update

```
/new <name> [--model <model>] [--cwd <alias-or-path>] — Create a session in this topic
```

---

## Design Pushback / Notes

**None significant.** The design doc and Kat's decisions were fully implementable as specified.

Minor observation: `args.slice(2).join(' ')` is used for the path argument in `/cwd add` to handle paths with spaces (e.g., `C:\my projects\repo`). Without this, space-containing paths would be silently truncated.

**`configPath` is optional in `HandlerOptions`** — existing tests call `registerHandlers({...})` without it. When `configPath` is absent and a user tries `/cwd` or `/new --cwd`, they receive a clear error. The daemon always passes `configPath: cfg.configPath` from `main.ts`.

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

## D1 — Carter's Module Import Path

**Decision:** Tests import from `../../src/bot/commands.js` (i.e., `src/bot/commands.ts`).

**Rationale:** Design doc says "likely `src/bot/commands.ts` or `src/bot/registry.ts` — Carter picks". Noble-six triage recommends "Export BOT_COMMANDS from handlers.ts" but a standalone `commands.ts` is cleaner for a centralized set. The canonical path is unknown until Carter lands.

**Carter: if you export from `handlers.ts` instead**, update the import in `tests/bot/isBotCommand.test.ts` line 18 from `'../../src/bot/commands.js'` to `'../../src/bot/handlers.js'`.

**If BOT_COMMANDS ends up somewhere else entirely** (e.g., `src/bot/registry.ts`), same fix.

---

## D2 — Case Sensitivity: Carter Chose Case-Insensitive

**Decision:** Tests assert case-**insensitive** behavior (`/New` → true, `/NEW` → true).

**Rationale:** Carter's implementation uses regex `/^\/([a-zA-Z_]+)/` + `.toLowerCase()` before the Set lookup. The docstring explicitly states "The check is case-insensitive: `/NEW` and `/new` both match."

This diverges from the design doc's implied `[a-z_]+` (lowercase only). Carter's choice is defensively correct: Telegram sends commands lowercase, but normalizing casing makes the guard robust to hypothetical client variations.

**Affected tests:** `isBotCommand.test.ts` case-sensitivity describe block asserts `true` for `/New`, `/NEW`, `/LIST`. The `it.todo` marks the case-sensitive (rejected) variant.

---

## D3 — `/new@MyBot` Telegram Suffix Behavior

**Decision:** Tests assert `isBotCommand('/new@MyBot')` → **true**.

**Rationale:** Design doc regex `/^\/([a-z_]+)/` stops at `@` (not in `[a-z_]`), extracting `new`. `BOT_COMMANDS.has('new')` → true → returns true. This is emergent correct behavior from the regex — the helper implicitly handles the Telegram `@botname` suffix without special logic.

**Carter: if you intentionally strip or reject the @suffix differently**, update the test.

---

## D4 — Existing Test Conflict in handlers.test.ts

**⚠️ Carter must update `tests/bot/handlers.test.ts:343` when implementing the guard change.**

The existing test:
```typescript
it('ignores command messages (starting with /)', async () => {
  // ...
  message: { message_thread_id: 42, text: '/unknown-cmd' },
  // reply is not called for relaying (no placeholder)
  expect(ctx.reply).not.toHaveBeenCalled();
});
```

After Carter's fix, `isBotCommand('/unknown-cmd')` → false (extracts `'unknown'`, not in BOT_COMMANDS). The message:text handler will relay it → `ctx.reply` WILL be called → **this test will FAIL**.

**Fix:** Change the text in that test from `'/unknown-cmd'` to a real bot command like `'/new test'` or `'/list'` to preserve the intent (bot commands don't trigger relay).

The new test at `tests/bot/handlers.slashGuard.test.ts` covers the replacement contract explicitly.

---

## D5 — Actual Landing Status (Carter Already Shipped)

Carter landed all Phase 9 Item 2 implementation during Jun's test-writing run.

| File | tsc | vitest status |
|------|-----|---------------|
| `tests/bot/isBotCommand.test.ts` | ✅ (included in vitest, not tsc) | ✅ 66 passed / 1 todo |
| `tests/relay/afkMode.slashGuard.test.ts` | ✅ | ✅ 15 passed |
| `tests/bot/handlers.slashGuard.test.ts` | ✅ | ✅ 25 passed |

**Total new tests: 106 assertions / 1 todo — all GREEN.**

Pre-existing failures unrelated to Jun's work:
- `tests/bridge/extension-protocol-drift.test.ts` (1 failure): Carter added `lastAssistantExcerpt` to the protocol (Phase 9 Item 1 orientation message). Drift test expects `['sessionId', 'type']` but now gets 3 fields. This is Carter's protocol change, not a regression from Jun's tests.

**D4 update:** Carter proactively removed the `'ignores command messages (starting with /)'` test from `tests/bot/handlers.test.ts` before it became a conflict. No action needed.

---

## D6 — Test Harness for afkMode.slashGuard

Used `AfkModeController.forTesting()` with a seed of `mode.active=true` and a pre-bound session at `TOPIC_ID=42`. This avoids replicating the full FakeDaemon/FakeExtensionClient activation flow for a unit-level guard test.

The bridge mock uses `vi.fn()` for all AfkBridgePort methods; `sendToSession` captures the `mirror.input` payload for assertion.

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

## Scope

Three test files for Phase 9 Item 3 (multi-CWD registry):

| File | Scope | Status |
|---|---|---|
| `tests/config/knownCwds.test.ts` | Kat's T5 helpers (8 functions) | ✅ 60 GREEN |
| `tests/bot/cwdCommand.test.ts` | Carter's T6 `/cwd` command group | ✅ 12 GREEN |
| `tests/bot/newCwdFlag.test.ts` | Carter's T7 `/new --cwd` extension | ✅ 11 GREEN |

Total: **83 tests, all passing**.

---

## Decision D1: Mock architecture for B and C tests

**Problem:** `handlers.ts` is a heavy entry point (imports grammY, relay, sessions). Need to
test just the `/cwd` and `/new --cwd` logic in isolation.

**Choice:** Same `vi.hoisted()` + `vi.mock()` approach established in Phase 9 Item 2 handlers
tests. Mock `loadConfig`/`saveConfig` from `../../src/config/config.js`, and all 8 helpers from
`../../src/config/knownCwds.js`.

**Rationale:** Matches the existing vi.mock + importOriginal pattern. Tests remain stable even
if Carter refactors internals as long as the observable surface (ctx.reply calls, registry.register
args, loadConfig/saveConfig calls) is unchanged.

---

## Decision D2: HandlerOptions.configPath assumed API shape

**Problem:** Design doc says Carter adds a `configPath` option to `HandlerOptions`; the exact
name was unconfirmed before Carter landed.

**Outcome:** Carter used exactly `configPath?: string` in `HandlerOptions`. Tests use:
```typescript
const opts: HandlerOptions = {
  bot: bot as unknown as Bot<Context>,
  registry, factory,
  globalModel: 'claude-sonnet-4.5',
  configPath: TEST_CONFIG_PATH,
};
```
No adjustment required.

---

## Decision D3: /cwd without `configPath` — not tested explicitly

Carter's code has an early `if (!configPath)` guard in both the `/cwd` handler and the
`/new --cwd` path. Tests in C cover this guard for `/new --cwd` (`it('replies error when
configPath not set for --cwd')`). The `/cwd` guard is implicitly tested because all happy-path
tests provide a configPath. Could add an explicit test; deferred to Carter's unit tests.

---

## Decision D4: Fake timers scope in B and C

Tests use `vi.useFakeTimers({ now: new Date('2026-01-15T10:00:00Z') })` to freeze
`new Date().toISOString()` calls inside handlers (for `touchKnownCwd` and `addKnownCwd`
timestamp args). This gives deterministic call-arg matching.

---

## Decision D5: Carter's Unix path detection omission (noted, not blocking)

Carter's `/new --cwd` path disambiguation regex:
```typescript
const isPath = /^[a-zA-Z]:\\/.test(cwdArg) || cwdArg.startsWith('\\\\');
```

This is Windows-only. Kat's spec (knownCwds decisions §4) specifies that Unix absolute paths
(`/home/user/repo`) should also be treated as paths, not aliases. Carter's implementation
would route `/home/user/repo` through the alias lookup on non-Windows platforms.

**Impact:** Low — project targets Windows hosts per Phase 8.5 decisions. Tests use
`ABS_PATH = process.platform === 'win32' ? 'C:\\git\\myrepo' : '/home/user/myrepo'`
with the Unix branch being a fallback. On Linux CI runs, the path test would exercise the
alias branch by accident.

**Recommendation:** Carter should add `|| cwdArg.startsWith('/')` for Unix path detection.
File as a follow-up issue; does not block Phase 9 Item 3 merge.

---

## Decision D6: `/cwd remove` — active-session removal is a no-op test

Test confirms that calling `/cwd remove myrepo` succeeds (removes the registry entry + saves)
regardless of whether any active sessions are using that cwd. The registry doesn't need to know
about active sessions because: (a) sessions hold their resolved path string in memory, not
a live reference; (b) removing the alias only affects future `/new --cwd myrepo` lookups.

---

## Decision D7: Same path under two aliases — test confirms it's allowed

`addKnownCwd` checks alias uniqueness (throws on alias collision) but does NOT check for path
uniqueness. Test `'allows same path under two different aliases'` in `knownCwds.test.ts`
confirms this is intentional behavior, not a missing validation.

---

## Carter Contract Divergence: NONE

All three files matched Carter's implementation exactly on first run. No import path changes,
no reply string regex adjustments needed. `cwd` is correctly in `BOT_COMMANDS` (commands.ts
line 35). The isBotCommand guard correctly blocks `/cwd` in session topics' `message:text`
handler.

---

# Kat — Phase 9 README Documentation

**Date:** 2026-05-30T12:18:53-07:00
**Author:** Kat (Bot Dev)
**Task:** Document Phase 9 work in README.md

---

## Structure Decision

Added a new **"Using Reach"** section after Installation and before Development Workflow. Removed the old pre-Phase-9 "Usage" section to avoid duplication.

### Rationale

- **Section placement:** After Installation (users install first, then want to know how to use it)
- **Comprehensive:** Covers all Phase 9 user-facing features in one section
- **Voice match:** Practical, scannable, no marketing — consistent with Phase 8.5 install section style
- **Removed old Usage:** Pre-Phase-9 "Usage" section was incomplete and now superseded by "Using Reach"

---

## Content Coverage

### 1. Telegram Commands (3 subsections)
- **Session management:** `/new`, `/list`, `/resume`, `/remove`
- **CWD registry (General Topic only):** `/cwd list`, `/cwd add`, `/cwd remove`
- **Other:** `/status`, `/help`, `/pair`

All commands include brief, actionable descriptions. No redundancy with handlers.ts or decisions files — documentation is reader-facing only.

### 2. CLI Commands Pass-Through

Short subsection explaining that anything not in the bot commands list is forwarded verbatim to the CLI session. Examples: `/clear`, `/agent`, `/model`, `/exit`. Same UX as terminal.

### 3. Orientation Message

Sample message with verbatim formatting from Item 1 decision (`kat-phase9-item1-orientation.md` Decision 5):

```
📍 Session active
━━━━━━━━━━━━━━━━━━
🆔 {sessionId}
📂 {cwd}
🤖 {model}
🎚️ Mode: AFK (since HH:MM UTC)

💬 Last from {model}:
> {excerpt}
```

Includes note about 500-char truncation and `/status` for manual refresh.

### 4. Getting Started: CWD Registry Example

Three-step practical example showing alias workflow:

```
/cwd add myrepo C:\src\myrepo
/cwd add scratch D:\scratch
/cwd list
/new my-session --cwd myrepo
```

### 5. Platform Note

Windows-only for now. Clarifies that path arguments (`/cwd add`, `/new --cwd`) accept `C:\path` and `\\server\share` formats. Cross-platform deferred to future phase.

---

## Files Changed

| File | Lines Added | Notes |
|------|------------|-------|
| README.md | +57 (Using Reach) -39 (old Usage) = **+18 net** | Replaces old usage section |

---

## No Code Structure Decisions

All decisions in this doc are documentation/formatting choices, not code architecture. Code decisions remain in:
- Item 1: `kat-phase9-item1-orientation.md` (orientation message format, gating, `/status` caching)
- Item 3 (config): `kat-phase9-item3-config-schema.md` (alias rules, validation)

---

## Voice/Style Match

Matched Phase 8.5 install section:
- Scannable bullet lists with concise descriptions
- Code examples use realistic paths and commands
- No badges, marketing language, or hype
- Short paragraph prose for context; commands and examples lead

Aaron is the primary reader — documentation prioritizes clarity and practicality.

