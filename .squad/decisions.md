> 📦 Entries from 2026-05-22 through 2026-05-30 archived. This archive process completed 2026-06-06.

---

> 📦 Entries from 2026-05-22 and earlier archived to decisions-archive-2026-05-29.md on 2026-05-29.

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



---

# Phase 9: Persona Review Cycle 3 — Final Pre-PR Pass

Date: 2026-05-31

# Kat Phase 9 Cycle 3 README Review Fixes

## A1: TELEGRAM_ALLOWED_USER_IDS Classification & REACH_PERMISSION_POLICY Documentation

### Decision: "Strongly Recommended" vs "Required"
- **Wording chosen:** "Strongly Recommended" (not "Optional")
- **Rationale:** Runtime behavior treats TELEGRAM_ALLOWED_USER_IDS as optional (env.ts lines 65-87 show allowedUserIdSet can be undefined), allowing all users when unset. However, the security risk is high — any user in the chat can control the daemon. This warrants prominence above plain "Optional" but stops short of "Required" to match the actual runtime enforcement.
- **Callout added:** "If not set, ANY user in the configured Telegram chat can control the daemon. Set this to your own numeric user ID to restrict access." (README line 47)

### Decision: REACH_PERMISSION_POLICY Surfacing
- **Location:** Configuration section (README lines 54), Environment Variables table (line 195)
- **Rationale:** The default `approveAll` has a critical side-effect (blocks Telegram mirror input per main.ts line 56), which users should know about at configuration time.
- **Wording:** "Tool approval policy (default: `approveAll`). Options: `approveAll` (daemon acts without approval — suitable for AFK usage), `denyAll` (daemon refuses tool use), or `interactiveDestructive` (daemon prompts for approval on destructive tools). Note: when `approveAll` is active, Telegram mirror input is blocked for safety." (README lines 54)

### Verification:
- env.ts lines 65–99: Confirmed allowedUserIdSet can be undefined
- install/index.ts line 173: Confirmed wizard message matches new callout
- main.ts line 56 + afkMode.ts line 168: Confirmed approveAll → mirror input disabled
- Environment table updated with full policy descriptions

## A2: /resume Command Signature
- **Change:** `/resume` → `/resume <session-name>`
- **Location:** README line 77 (Telegram Commands section)
- **Verification:** handlers.ts line 247 confirms the handler enforces `ctx.match?.trim()` and errors if empty with usage hint `/resume <session-name>`
- **Related edit:** npm run init description (line 34) clarified to match new classification

### Spot-Check: Other Command Signatures
All verified against handlers.ts and match README documentation:
- `/new <name> [--model <model>] [--cwd <alias-or-path>]` ✅
- `/list` (no args) ✅
- `/remove` (no args, topic-scoped) ✅
- `/pair <code>` ✅
- `/help` (no args) ✅
- `/status` (no args, topic-scoped) ✅
- `/cwd list|add|remove` ✅

No sibling command-signature drift detected.


---

# Carter — Phase 9 Review Cycle 3 Decisions

Date: 2026-05-31

---

## A4 — Single source of truth for bot command registration

**Choice: Option A (name-map variant)**

Rationale: The existing handlers.ts shape already had large inline closures for each command, all capturing the same outer scope variables (registry, relay, factory, etc.). Extracting them into named properties of a `Record<CommandName, (ctx: Context) => Promise<void>>` object literal — rather than wrapping them in explicit `registerXxx` functions per Option B — preserves the existing closure pattern with minimal restructuring. Each handler body is unchanged; only the declaration site moved from `bot.command('x', async (ctx) => {` to `x: async (ctx) => {`.

The registration loop `for (const name of COMMAND_NAMES) { bot.command(name, commandHandlers[name]); }` then drives registration from a single array, making the relationship mechanical rather than maintained-by-convention.

**Drift check: deleted.**

The check was comparing `REGISTERED_HERE` (a hand-maintained duplicate list in handlers.ts) against `BOT_COMMAND_NAMES` (derived from the same list in commands.ts). After the refactor, there is no `REGISTERED_HERE` — the `commandHandlers` object is typed as `Record<CommandName, ...>`, so TypeScript enforces at compile time that every name in `COMMAND_NAMES` has a corresponding handler. The old runtime throw is replaced by a build-time error. Dead safety code removed.

**Final exports from commands.ts:**
```typescript
export const COMMAND_NAMES = ['new','list','remove','resume','help','pair','status','cwd'] as const;
export type CommandName = typeof COMMAND_NAMES[number];
export const BOT_COMMANDS: ReadonlySet<string> = new Set(COMMAND_NAMES);
export const BOT_COMMAND_NAMES = BOT_COMMANDS;  // alias kept for isBotCommand.test.ts
export function isBotCommand(text: string): boolean
```

**Note on ctx.match typing:** Inside `bot.command()`, grammY narrows `ctx.match` to `string | undefined`. With the `Record<CommandName, (ctx: Context) => Promise<void>>` annotation, the base `Context` type exposes `match` as `string | RegExpMatchArray | undefined`. Two callsites (`/new`, `/resume`) required `(ctx.match as string | undefined)?.trim()` casts. This is accurate — inside command handlers, match is always string.

---

## A5 — parseNewFlags discriminated Result type

**Choice: discriminated `ParseResult<T>` union; all throws caught at public boundary.**

Internal helpers (`tokenize`, `parseFlagValue`) continue throwing — that's natural for tokenizer internals. `parseNewFlags` wraps its entire body in `try/catch` and converts all throws to `{ ok: false, error }`. The multi-word session name path (previously `return { sessionName, error: '...' }`) now returns `{ ok: false, error: '...' }` as well, unifying both error paths.

**Final public signature:**
```typescript
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface ParsedNewFlagsValue { sessionName: string; model?: string; cwd?: string; }
export function parseNewFlags(match: string): ParseResult<ParsedNewFlagsValue>
```

**Caller in handlers.ts `/new` handler (before: try/catch + if parsed.error):**
```typescript
const parsed = parseNewFlags(input);
if (!parsed.ok) {
  await ctx.reply(`❌ ${parsed.error}`, { message_thread_id: topicId });
  return;
}
const name = parsed.value.sessionName;
const model = parsed.value.model;
const cwdArg = parsed.value.cwd;
```
No try/catch at the callsite. Cleaner control flow.

**Test refactoring:**
- All `expect(() => parseNewFlags(...)).toThrow()` → `expect(parseNewFlags(...).ok).toBe(false)` (5 tests)
- Multi-word `expect(result.error).toMatch(...)` → `expect(result.ok).toBe(false)` + `expect(result.error).toMatch(...)` (2 tests)
- Happy-path `result.sessionName` / `result.cwd` / `result.model` → `result.value.sessionName` / `result.value.cwd` / `result.value.model` (all remaining tests)
- Added `if (!result.ok) return;` narrowing guard before value access in happy-path tests for TypeScript narrowing.

---

## Validation

- `npx tsc --noEmit` — clean
- `npm run lint --max-warnings 0` — clean  
- `npx vitest run` — 783 passed / 4 skipped / 1 todo (identical to baseline)


---
# Decision: Full process.argv save/restore in isDirectRun tests

**Date:** 2026-06-05  
**PR:** #10, Cycle 10  
**Thread:** T1 — `tests/install/isDirectRun.test.ts:20-32`  
**Author:** Carter (Bridge Dev)

## Decision

Replace the cycle-6 `argv[1]`-only save/restore pattern with a full-array
save/restore in `isDirectRun.test.ts`.

**Before (cycle-6 pattern):**
```ts
let savedArgv1: string | undefined;
beforeEach(() => { savedArgv1 = process.argv[1]; });
afterEach(() => {
  if (savedArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = savedArgv1;
  }
});
```

**After:**
```ts
let savedArgv: string[];
beforeEach(() => { savedArgv = process.argv.slice(); });
afterEach(() => { process.argv = savedArgv; });
```

## Rationale

Cycle 6 fixed a state leak caused by the original `afterEach` not handling the
case where `argv[1]` was `undefined` (it would write `undefined` back as a
string). The cycle-6 fix saved/restored only `argv[1]`.

IDR5 (added later) calls `process.argv.splice(1)` which mutates the **array
length** — removing all elements from index 1 onward. Restoring only `argv[1]`
does not undo the splice; any elements beyond index 1 remain absent. This can
cause order-dependent flakiness in tests that run after IDR5 and rely on
`process.argv` having its normal shape.

A full-array `slice()` snapshot at `beforeEach` and full reference restore at
`afterEach` handles:
- `argv[1]` being `undefined` (naturally preserved in the slice)
- `argv[1]` being `''` (distinguished correctly, same as cycle-6)
- `splice`-based length mutations (restored by reference reassignment)

## Supersedes

Cycle-6 `argv[1]`-only pattern. The full-array pattern is strictly more
correct and no more complex.

---
# carter-pr10-cycle11: relativeTime() Guards

**Date:** 2026-06-05  
**Author:** Carter (Bridge Dev)  
**PR:** #10 — Cycle 11

---

## Decision 1: NaN fallback string → `'unknown'`

**Choice:** Return `'unknown'` when `Date.parse(iso)` yields `NaN`.

**Rationale:**
- `'just now'` would be misleading — the timestamp isn't *recent*, it's *unreadable*.
- `'unknown'` is honest and already fits the output vocabulary of the `/cwd list` rendering
  (`last used unknown`), which reads naturally as a data-quality indicator rather than a time claim.
- It avoids emitting garbled strings like `'NaNd ago'` that would confuse users and
  look like bugs in screenshots.

---

## Decision 2: Future timestamp clamp → `diffMs = Math.max(0, ...)`

**Choice:** Clamp `diffMs` to `0` when the stored timestamp is ahead of `Date.now()`.

**Rationale:**
- Small positive skews (seconds to minutes) arise from NTP drift between the machine that
  wrote the config and the machine running the bot. They are not errors — they are expected noise.
- Clamping to 0 means the `mins < 1` branch fires and returns `'just now'`, which is the
  correct human interpretation of "happened approximately now".
- Negative diffMs would propagate through `Math.floor` into negative minute/hour/day values,
  producing output like `'-1m ago'` — nonsensical and unhandled by the existing branches.
- An explicit `Math.max(0, ...)` is self-documenting and cheaper than adding a dedicated
  negative-branch to an otherwise clean function.

---
# carter-pr10-cycle12: Wipe Markers Audit + Quoted Session Name Fix

**Date:** 2026-06-05  
**Author:** Carter (Bridge Dev)  
**PR:** #10 — Cycle 12

---

## T1: registry.json Added to wipeLocalData() Marker List

### Markers added

`registry.json` added to the `markerFiles` array in `wipeLocalData()` (`src/install/uninstall.ts:64`).

**Source:** `src/config/env.ts:43` — `path.join(getReachDataDir(), 'registry.json')`. The file
is a direct child of the data dir (not nested). No exported constant exists for the basename, so
`'registry.json'` is inlined — consistent with how `'config.json'` and `'bridge-auth.json'` are
already expressed.

### Full marker audit against `<dataDir>/` state files

| File | Source | In marker list before? | Action |
|---|---|---|---|
| `config.json` | `src/config/config.ts` `getConfigPath()` | ✓ yes | no change |
| `bridge-auth.json` | `src/bridge/pipeAuth.ts` `getPipeAuthPath()` | ✓ yes | no change |
| `registry.json` | `src/config/env.ts` `registryPath` | ✗ missing | **added** |

No other `<dataDir>/…` constructions found in the codebase. `src/config/migrate.ts` copies from
legacy dirs into `<dataDir>` but introduces no new files beyond the three above. The marker list is
now exhaustive for all known Phase 9 state files.

**Broadening concern:** All three markers are specific Reach JSON files. A random directory
containing an unrelated `registry.json` (e.g. an npm package) would be a false positive, but the
combination check (`some`) means _any_ of the three triggers a pass — the safety check is already
using a low-confidence bar by design (fail-closed on inspection error). Adding one more
Reach-specific name is appropriate.

---

## T2: Unified Whitespace Check for Session Name

### Decision: Unify both paths (`sessionParts.length > 1` replaced by `/\s/.test(sessionName)`)

**Chosen approach:** Replace the `sessionParts.length > 1` guard with a single `/\s/.test(sessionName)`
check applied to the final resolved session name.

**Rationale:**
- The root invariant is: _a session name must not contain whitespace_, regardless of how the
  whitespace got there (unquoted split vs. quoted single token).
- `sessionName = sessionParts.join(' ').trim()` already collapses all session parts into one string.
  Testing that string for `\s` catches both paths:
  - Unquoted `my session` → two tokens → `sessionName = 'my session'` → `\s` fires ✓
  - Quoted `"my session"` → one token `'my session'` → `\s` fires ✓
- The unified check is shorter, has one fewer code path, and its intent is self-evident.
- Error message is identical between both cases — callers see consistent semantics.

**Alternative considered:** Add a second guard after the existing `sessionParts.length > 1` check.
Rejected — two parallel checks with the same error string are redundant and invite drift.

---
# Carter — PR #10 Cycle 13 Decisions

**Branch:** user/aaron/phase9  
**Date:** 2026-06-05  
**Commit scope:** test (test-only changes)

---

## T1/T2 — Fake-token constant

**Constant chosen:** `FAKE_GH_TOKEN = 'not-a-real-token-0000'`

**Rationale:**  
T1 and T2 both exercise the ENV-assignment pass (`GITHUB_TOKEN=<value>` /
`GITHUB_TOKEN="<value>"`). `ENV_ASSIGNMENT_PATTERN` requires the value to match
`[^\s'"]{8,}` — at least 8 non-space, non-quote characters. The original
`ghp_abcdefghijklmnopqrstuvwxyz12345678` is a `ghp_`-prefixed 40-char value
that GitHub secret scanning recognises as a real PAT shape (prefix + length +
charset).

`not-a-real-token-0000` (21 chars) satisfies `[^\s'"]{8,}`, contains `-` which
is never present in a real GitHub PAT, and is lexically unmistakeable as fake.
It is reused verbatim for the quoted C6-4 variant so both tests reference a
single constant, making intent clear.

No change to what the tests assert — just the fixture value inside the quotes.

---

## T3 — Bare-value restructuring (high-entropy charset guard)

**Problem (Copilot review):** The original test used
`AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`. Because
`AWS_SECRET_ACCESS_KEY` matches `ENV_ASSIGNMENT_PATTERN` (the `ACCESS_KEY`
suffix), the ENV pass redacts the value on Pass 2 *regardless* of whether the
high-entropy charset is correct. If someone reverted the cycle-8 `/`+`+` charset
extension in `HIGH_ENTROPY_PATTERN`, this test would still pass — false safety.

**Fix:** Drop the `AWS_SECRET_ACCESS_KEY=` prefix entirely. The new fixture is:

```
FAKE+Xm3z9pQr/vNsLwD7hYc+E4aOjZtFu1Ii/8bGn  (42 chars)
```

This bare value is only reachable by `HIGH_ENTROPY_PATTERN` (Pass 3).

**Why this value specifically:**
1. Length 42 ≥ 39 threshold — matches as a single run. ✓
2. Contains `/` (position 13) and `+` (positions 4, 24) — the chars added in
   cycle-8.
3. Contains no keyword words (`token`, `key`, `secret`, …) at word boundaries,
   so `KEYWORD_PATTERN` (Pass 1) does not fire first. (Earlier draft used
   `…/aws/key/…` which caused `\bkey\b` to match and produce
   `…/aws/key[REDACTED]` instead of `[REDACTED]`.)
4. Starts with `FAKE` — obviously not a real credential; won't trip AWS secret
   scanning (which looks for `AWS` prefix + length + alphanumeric pattern).

**Charset-regression proof:** If `HIGH_ENTROPY_PATTERN` reverted to
`[A-Za-z0-9_\-]{39,}` (no `/`, no `+`), the 42-char value fragments at each
`/` and `+`:
- `FAKE` (4), `Xm3z9pQr` (8), `vNsLwD7hYc` (10), `E4aOjZtFu1Ii` (12), `8bGn` (4)
- Longest fragment: 12 chars — far below the 39-char threshold.
- Neither `not.toContain(bare)` nor `toBe('[REDACTED]')` would hold → test FAILS.

**Companion assertion added:** `expect(result).toBe('[REDACTED]')` — verifies the
whole 42-char run was matched as one token, guarding against the fragmentation
scenario above.

---

## Sibling `ghp_` scan

Grepped all `tests/**/*.ts` for `ghp_`. Only two occurrences found, both in
`tests/bot/redactSecrets.test.ts` (lines 60 and 154) — both fixed by T1/T2
above. No sibling fixtures elsewhere.

---
# Carter — PR #10 Cycle 14 Decisions

**Date:** 2026-06-05  
**Bugs addressed:** T2 (connectivity-breaking path mismatch), T1 (stale socket cross-connection frame leak)

---

## 0. extension.mjs — source or generated?

**Finding: HAND-EDITED source file.**

- Not in `.gitignore`
- Committed to git (earliest log entry predates Phase 9)
- No TypeScript counterpart (`src/extension*` — no matches)
- No build script in `package.json` that emits it (`build` = `tsc --project tsconfig.json` only)
- No "GENERATED — do not edit" header comment
- Header says "Reach CLI Extension" — authored prose

**Consequence:** Both T1 and T2 fixes were applied directly to `extension.mjs`.

---

## T2 — Auth file path mismatch (daemon ↔ extension)

### Root cause

`getReachDataDir()` in `src/config/config.ts` was migrated to `~/.reach/` in Cycle 3
(PR #10 storage unification). `pipeAuth.ts` uses `getReachDataDir()` so the daemon
correctly writes `~/.reach/bridge-auth.json`. However, `getAuthFilePath()` in
`extension.mjs` was never updated and still read from `%LOCALAPPDATA%\reach\bridge-auth.json`.
Daemon writes to `~/.reach/`; extension reads from `%LOCALAPPDATA%\reach\` — completely
different directories → extension never discovers the pipe → zero connectivity.

### Fix

Rewrote `getAuthFilePath()` in `extension.mjs` to mirror `getReachDataDir()` in
`src/config/config.ts` exactly:

```js
function getAuthFilePath() {
  const override = process.env['REACH_DATA_DIR'];
  const dataDir = (override && override.trim() !== '')
    ? resolve(override.trim())
    : join(homedir(), '.reach');
  return join(dataDir, 'bridge-auth.json');
}
```

Added `resolve` to the `node:path` import.

### LOCKSTEP REQUIREMENT

**⚠️ The path-resolution logic is now duplicated across two runtime boundaries:**

| File | Runtime | Logic |
|------|---------|-------|
| `src/config/config.ts` `getReachDataDir()` | TypeScript (compiled) | `REACH_DATA_DIR` override → `path.resolve(override.trim())`, fallback `~/.reach` |
| `extension.mjs` `getAuthFilePath()` | Standalone JS | Mirrors above exactly |

These two cannot import each other (TS daemon vs standalone `.mjs` extension deployed separately).

**Rule:** Any future change to `getReachDataDir()` in `src/config/config.ts` MUST be
manually mirrored in `extension.mjs getAuthFilePath()`. Code review checklist should
include this when `src/config/config.ts` is modified.

A comment in both files now calls this out explicitly.

### Tests

- Fixed N2 tests in `tests/bridge/b3-pipe-auth.test.ts`: changed `vi.stubEnv('LOCALAPPDATA', tempDir)`
  to `vi.stubEnv('REACH_DATA_DIR', tempDir)`. The old stubs were broken — they stubbed
  `LOCALAPPDATA` but `getReachDataDir()` reads `REACH_DATA_DIR`, so the tests were not
  actually redirecting the file path (side-effecting the real `~/.reach/` directory).

- Added N3 suite (4 tests) pinning the daemon's `getAuthFilePath()` contract:
  - Default path (`~/.reach/bridge-auth.json`)
  - `REACH_DATA_DIR` absolute override
  - Whitespace trimming
  - Whitespace-only string treated as unset

- **Extension-side path not unit-testable from current TS harness.** `getAuthFilePath()`
  is not exported from `extension.mjs`, and the file is a side-effectful module that
  immediately connects (cannot safely import in a test). The N3 daemon-side tests + code
  review of the mirrored logic provide the safety net.

---

## T1 — Stale pipeSocket cross-connection frame leak in streamSdkResponse()

### Root cause

`pipeSocket` is a module-level mutable that is swapped on reconnect (see `connectToDaemon()`,
line ~795: `pipeSocket = socket`). The `enqueueFrame` closure inside `streamSdkResponse()`
enqueued tasks that read `pipeSocket` at execution time. If a reconnect occurred between
enqueue and execution, the task would see the **new** `pipeSocket` and write old-stream
frames onto the new connection. The daemon's new connection has no knowledge of the old
`requestId` → framing corruption.

### Fix

Captured `pipeSocket` into a local `const socket` at the **start** of each stream
(immediately after `await gate` — serial entry through `streamQueue`). All writes for
this stream target the captured `socket`:

1. **`enqueueFrame` early-out:** `if (socket === null || socket.destroyed) return;`
   — prevents enqueuing when the captured socket is already gone.

2. **`.then()` body stale-check:** `if (socket !== pipeSocket || socket.destroyed) return;`
   — at execution time, if a reconnect swapped `pipeSocket`, the frame is dropped.
   Old-stream frames must never land on a new connection.

3. **Final done=true frame:** guarded with `socket !== null && !socket.destroyed && socket === pipeSocket`
   before calling `sendToDaemon`. If a reconnect happened, the done frame is silently
   dropped (new connection gets fresh streams only).

4. **Error frame in catch:** `const canNotify = socket === null || (!socket.destroyed && socket === pipeSocket)`
   — `socket === null` means the error occurred before the stream started (before
   `await gate`), so fall through to `sendToDaemon`'s own guard. Otherwise, only
   notify if still on the same connection.

`socket` is declared with `let socket = null` **before** the outer `try` block so it
is in scope in `catch`.

### Failure mode analysis

| Scenario | Behavior |
|----------|----------|
| No reconnect during stream | `socket === pipeSocket` throughout → no change from existing behavior |
| Reconnect between enqueue and execution | `socket !== pipeSocket` → frame dropped → new connection receives only fresh stream frames |
| Socket destroyed (daemon crash, no reconnect) | `socket.destroyed` → frame dropped → no unhandled write error |
| Error before stream started | `socket === null` → `sendToDaemon` path, existing guard applies |

### Tests

- `FakeExtensionClient` + `FakeDaemon` operate over in-memory `PassThrough` streams,
  not through `extension.mjs` directly — the streaming path in `extension.mjs` is tightly
  coupled to `sdkSession` events and cannot be driven via the existing harness without
  extracting `streamSdkResponse()` as a pure function or introducing SDK mocks.
- **Testability limitation documented:** No test added for T1. Correctness relies on
  careful reasoning + the captured-socket guard pattern (standard JS closure capture
  semantics). The guard is idiomatic and risk is low given serial `streamQueue`.

---

## Tests summary

- N2 (2 tests): fixed stub from `LOCALAPPDATA` → `REACH_DATA_DIR` — were silently broken
- N3 (4 tests): new path-contract suite for daemon `getAuthFilePath()`
- Net test delta: +4 (845 → 849)

---
# Carter — PR #10 Cycle 15 Decisions

**Date:** 2026-06-06  
**Thread:** T1 — Secret prompt echoes bot token to terminal (`src/install/index.ts:92-99`)

---

## D1: Masking approach — blank vs asterisk

**Decision: blank (option a) — no echo at all.**

Blank masking (fully suppressed output) is chosen over asterisk masking (`*` per char). Rationale:
- Standard behavior for secret entry (matches `sudo`, Python `getpass`, SSH passphrases)
- Does not leak token length (asterisks reveal how many chars were typed)
- Simpler implementation — one-liner suppressor vs char-counting echo

Pattern used: `(rl as any)._writeToOutput` override with a function that writes the prompt text through on the first call and swallows all subsequent writes (echoed keystrokes). This is the **same idiom already used in `src/service/install.ts` `promptPassword()`**. Consistent with established codebase practice.

---

## D2: New helper — `promptSecret`

Added `promptSecret(message)` alongside existing `promptLine(message)` in the prompt helpers block. Used for `TELEGRAM_BOT_TOKEN` prompt only. `TELEGRAM_ALLOWED_USER_IDS` is not a secret (numeric user IDs, not credentials) and keeps `promptLine`.

`promptSecret` is intentionally not exported; it's local to the install wizard, same as `promptLine`.

---

## D3: Non-TTY degradation

No special handling needed in `promptSecret` itself. The wizard already gates on `process.stdin.isTTY` before any prompting:

```typescript
if (needsPrompt && !process.stdin.isTTY) {
  // exits with instructions
  process.exit(1);
}
```

`promptSecret` is only called inside the `if (!botToken)` block, which is only reached after the non-TTY gate. Safe by design.

---

## D4: Sibling audit findings

- **`src/install/uninstall.ts`**: No readline prompts at all. Clean.
- **`src/service/install.ts` `promptPassword()`**: Already has `_writeToOutput` masking (cycle predates this fix). No action required.
- **Token echo-back**: After capturing the bot token, the wizard logs `[reach] Written to <envPath>` — the path only, not the token value. No accidental echo. Clean.

---

## D5: Test observability limitation

The readline mock (`vi.mock('readline', ...)`) returns a plain object with a synchronous `question` stub. The mock has no real TTY output stream, so the `_writeToOutput` suppression cannot be observed by watching stdout content.

Mitigation: `capturedWriteFns` array added to hoisted mock state. The mock's `question` stub captures `rl._writeToOutput` at call time, allowing tests to assert the suppressor function was in place during the bot token prompt (IX18) and absent for the subsequent non-secret prompt (IX19).

The output-stream content assertion (IX19 comment) documents this limitation explicitly.

---
# Carter PR #10 — Cycle 16 Decisions

**Date:** 2026-06-06  
**Branch:** user/aaron/phase9 @ d899d41

---

## T1 — BOT_COMMAND_NAMES: DELETE (Case A: genuinely dead)

### Investigation

`BOT_COMMAND_NAMES` was introduced in cycle 3 as a shared command registry alias:

```ts
// src/bot/commands.ts:36
export const BOT_COMMAND_NAMES = BOT_COMMANDS;
```

**Grep evidence — zero live references:**

```
src/      → no references outside the definition itself
tests/    → no references at all
```

Only non-code mentions found:
- `.squad/agents/carter/history.md` — historical narrative, not a code reference
- `.squad/decisions.md` — two mentions, both documenting past decisions:
  1. "Added alias export `BOT_COMMAND_NAMES` and startup drift check in `registerHandlers`" — the drift check was subsequently removed
  2. "alias kept for isBotCommand.test.ts" — that test imports only `isBotCommand` and `BOT_COMMANDS`, not `BOT_COMMAND_NAMES`

**No hardcoded duplicates to wire up.** The codebase uses `BOT_COMMANDS` (the actual `ReadonlySet`) everywhere it needs the set. Nothing is hardcoding a second command-name list that `BOT_COMMAND_NAMES` should be driving.

### Decision

**DELETE.** Case (a): genuinely dead export. The drift check it was originally paired with was removed in a prior cycle; `isBotCommand.test.ts` does not import it. YAGNI applies — a future consumer can re-add if needed.

**Change:** Removed line 36 from `src/bot/commands.ts`. No test imports required updating.

---

## T2 — handlers.slashGuard.test.ts file header: REWRITTEN

The "RED tests (awaiting Carter)" / "⚠️ EXISTING TEST CONFLICT" header was stale. The implementation landed in this PR: `isBotCommand()` guard is live in `handlers.ts`, and `handlers.test.ts` was already updated to use `/list` instead of `/unknown-cmd`. Rewrote the header to describe present reality.

---

## T3 — handlers.slashGuard.test.ts inline scaffold comments: REMOVED

Removed "RED until Carter:" inline comments from test bodies (5 occurrences). Replaced the stale conflict note in the `/unknowncommand` test with a factual note that `handlers.test.ts` was already updated in this PR. Removed stale section heading suffix "(RED until Carter)".

---

## Extra — afkMode.slashGuard.test.ts: same treatment applied

`tests/relay/afkMode.slashGuard.test.ts` carried the same generation of TDD scaffold (file header "RED tests (awaiting Carter)", 5 inline "RED until Carter." body comments, stale section heading). Carter's AFK guard change is also live in this PR. Applied identical cleanup: rewrote header to describe current reality, removed inline RED scaffolding.

## Extra — isBotCommand.test.ts: stale anticipatory header and B1 describe label

- File header: removed "RED until Carter lands src/bot/commands.ts" / "Expected import failure" framing; the module is live.
- `describe('isBotCommand — B1: digit handling (anticipatory)')` → removed "(anticipatory)" suffix and the "RED until Carter lands the regex change" block comment above it; the fix has landed.

---
# Carter — PR #10 Cycle 2 Decisions

Date: 2026-05-31

## Thread 1 — /cwd list reply text

**Decision:** Fixed the hint text inline. Changed `/new <alias>` → `/new <session-name> --cwd <alias>` at `cwdCommand.ts:106`. No structural complexity; single-line fix.

## Thread 2 — removeExtension resilience

**Return type chosen:** `StepResult = { label: string; ok: boolean; reason?: string }`.
- Both `removeExtension()` and `wipeLocalData()` now return `StepResult` instead of `void`.
- `wipeLocalData()` was already non-fatal for the rmSync failure path; it is now also counted as a step that can fail (ok: false) so the orchestrator can report it accurately.
- The "not a Reach state directory" safety refusal also returns `{ ok: false }` — the user requested wipe but it didn't happen, so that's a failure worth reporting.

**Orchestrator aggregation:** `runUninstall` collects `StepResult[]` from all sync steps, then calls `uninstall()` (which handles its own exit via node-windows). If `uninstall()` returns (in tests, or on platforms where it doesn't exit directly), the orchestrator prints a summary and calls `process.exit(1)` only if any step failed. This means the service always runs regardless of earlier failures — idempotency contract preserved.

**Caveat:** In production, the node-windows service uninstaller calls `process.exit` internally, so the summary block after `uninstall()` may not execute. This is an existing architectural constraint that would require refactoring the service layer to fix — out of scope for this wave. The user still sees the per-step error logs as they occur.

**Test added:** UN7 — `removeExtension` fails (rmSync throws EPERM) → service still called → `process.exit(1)` at end.

## Threads 3/4/5 — isDirectRun path normalisation

**Decision: extracted to a shared helper** (`src/install/isDirectRun.ts`).
- Rationale: all three files had the exact same bug. A single helper ensures the fix is applied uniformly and gives a natural home for any future edge-case work (e.g., case-folding on Windows).
- The helper uses `path.resolve(process.argv[1])` to normalise relative paths to absolute, then compares against `fileURLToPath(importMetaUrl)` which is already absolute.

**Windows case-sensitivity:** Not added. Both `fileURLToPath(import.meta.url)` and `path.resolve(process.argv[1])` derive from the same Node.js filesystem view; in practice they carry the same casing. No flake observed in CI. If a flake surfaces in the future, add `.toLowerCase()` inside the helper guarded by `process.platform === 'win32'`.

**Tests added:** `tests/install/isDirectRun.test.ts` with IDR1–IDR4 covering absolute match, relative-path match, different file (false), and empty argv[1] (false).

## Anything that pushed back

Nothing unexpected. The `wipeLocalData` readdirSync is not mocked in `uninstall.test.ts`; it falls through to the real `fs`, throws because the mock path doesn't exist on disk, and the existing catch block handles it — tests were already relying on that behaviour implicitly. No change needed.

---
# Carter — PR #10 Cycle 3 Fix Decisions

**Wave:** Cycle 3 (PR #10, branch user/aaron/phase9)
**Date:** 2026-05-31
**Threads:** T2 (service uninstall composability), T6 (noble-six consolidation), T7 (isBotCommand header comment), T8 (TELEGRAM_ALLOWED_USER_IDS wizard validation)

---

## T2 — uninstallService() Promise shape

**Final shape:** `export function uninstallService(): Promise<void>` (sync wrapper returning a Promise, not async).

**Settled-guard pattern:** Boolean `settled` flag, checked at the top of every event handler and the timeout callback. First event wins; late arrivals are no-ops. Matches the extension.mjs streaming fix pattern (Noble Six Phase 8.5).

**Timeout duration:** 60 000 ms (60 s). Chosen as a safe upper bound for node-windows SCM round-trip. Rejects with `'[reach] Service uninstall timed out after 60 s — uninstall event never fired'`.

**Listener cleanup:** `clearTimeout(timer)` called in a shared `finish(err?)` helper that both resolves and rejects. Timer is the only external resource; node-windows event listeners are not manually removed (they become inert after `settled = true`).

**Backward-compat shim:** `uninstall()` kept as a synchronous CLI shim that calls `uninstallService().then(() => process.exit(0)).catch(() => process.exit(1))`. This preserves the existing observable behavior for any code that imports the old `uninstall()` export.

**main() update:** `service/install.ts:main()` now `await uninstallService()` with explicit `process.exit(0|1)` instead of calling the shim.

**runUninstall() changes:**
- Promoted to `async function runUninstall(): Promise<void>`.
- Service step is now a tracked `StepResult` (`{ label: 'Uninstall Windows service', ok: true/false }`).
- On rejection: logs error, pushes `{ ok: false, reason }`, continues to step summary.
- `isDirectRun` block chains `.then(() => process.exit(0)).catch(() => process.exit(1))`.

**New tests:** UN8 (service rejects → exit 1), UN9 (service resolves → no exit). Existing UN1–UN7 updated to async/await. All 9 tests green.

---

## T6 — Noble Six directory consolidation

**Source of truth kept:** `noble-six/` (hyphenated). Physical merge performed — `noble six/` git-removed, content preserved.

**Charter decision:** Kept the single charter from `noble six/charter.md` (the only copy; `noble-six/` had no charter before). Updated one stale inbox path reference: `noble six-{brief-slug}` → `noble-six-{brief-slug}`.

**History merge:** `noble-six/history.md` was the shorter/newer file (Opus 4.5 instance, Phase 9 only). `noble six/history.md` was the comprehensive summarized file (Opus 4.6 instance, Phases 6–9+). Merge strategy:
- Used `noble six/history.md` as base (complete phase history + learnings).
- Inserted the unique "Phase 9 Sprint" detail block from `noble-six/history.md` (sprint breakdown, Knowledge Base, Decision Consolidation, No Further Phases Assigned) before the existing Learnings section.
- The overlapping streaming-fix section (2026-05-30T22:08) was present in both; kept the `noble six/history.md` copy (which has the Learnings appendix following it) — deduplicated as instructed.

**history-archive.md:** Copied verbatim from `noble six/` to `noble-six/` (Phase 1–5 archive).

**No merge conflicts:** Both files were append-only; no conflicting edits detected.

**team.md:** Updated to `.squad/agents/noble-six/charter.md`.

**Casting registry:** `casting/registry.json` key left as `"noble six"` (string identifier used by agent dispatch, distinct from folder path). Only the physical folder path and charter reference were renamed.

---

## T8 — TELEGRAM_ALLOWED_USER_IDS validation regex

**Validation regex:** `/^[1-9][0-9]*$/` — positive integer, no leading zero, no negative, no decimal, no whitespace in the token itself.

**Normalization:** Input split on `,`, each token `.trim()`-ed, joined back as `tokens.join(',')` before writing. Handles `"123, 456"` → `"123,456"`.

**Alignment with parseEnv:** `parseEnv` accepts tokens that pass `t.length > 0 && Number.isInteger(Number(t)) && Number(t) > 0`. The wizard's `/^[1-9][0-9]*$/` regex is a strict subset: it rejects leading zeros (e.g., `"007"`), which would technically pass `Number()` conversion (`Number("007") === 7`) — a deliberate tightening to reject ambiguous input. No valid use case for leading zeros in Telegram user IDs.

**Divergence from parseEnv:** The wizard rejects `"007"` (leading zero); parseEnv would accept `7` derived from it. This is intentional — the wizard is the canonical entry point and should be stricter than the runtime parser.

**Retry cap:** 3 attempts. On each invalid attempt, error is printed and user is reprompted. After the 3rd failure (or on blank input at any point), falls through to skip-with-confirmation (existing Q2 behavior).

**New tests:** IX14 (valid `123,456`), IX15 (invalid then valid retry), IX16 (whitespace normalization), IX17 (empty token rejection + skip flow). All 4 tests green.

---
# Carter — PR #10 Cycle 3 Storage Migration Decisions

**Date:** 2026-05-31  
**Branch:** user/aaron/phase9  
**Author:** Carter (Bridge Dev)

---

## Migration Approach: Option A (Explicit)

**Decision:** Approach A — `migrateLegacyDataDir()` is an explicit function called from two entry points: `src/install/index.ts` (`runInit`) and `src/main.ts` (`main`).

**Reasoning over Option B (lazy / first-call):**
- Explicit call sites are easier to test: tests can call the function directly and assert side effects without going through `getReachDataDir()`.
- The module-level `migrationAttempted` flag in Option B couples migration state to module lifecycle, making reset tricky in test environments (requires `vi.resetModules()`). In Option A the flag lives in `migrate.ts` which can be independently reset.
- Explicit call sites make it obvious in the install and daemon startup that "migration runs here" — future maintainers don't need to know that `getReachDataDir()` has side effects.
- Aaron's install is single-machine; the extra explicitness costs nothing.

**Tradeoff accepted:** If someone adds a third entry point and forgets to call `migrateLegacyDataDir()`, migration won't run there. Acceptable: the two call sites (install + daemon start) cover the entire install lifecycle.

---

## REACH_DATA_DIR Resolution Rules

| Input | Behavior |
|-------|----------|
| Not set | `path.join(os.homedir(), '.reach')` |
| Empty string `""` | Treated as absent — uses default |
| Whitespace only `"   "` | `.trim()` → empty → treated as absent — uses default |
| Absolute path | `path.resolve(value.trim())` — resolved as-is |
| Relative path | `path.resolve(value.trim())` — resolved relative to `process.cwd()` |

**Rationale:** `.trim()` before empty-check prevents accidental whitespace (e.g., trailing newline in a `.env` file) from being used as a path. `path.resolve()` normalises both relative and absolute paths, making the output always absolute.

---

## Hardcoded Path Strings Found Beyond Initial Scope

Grepped `src/` for `LOCALAPPDATA`, `APPDATA.*reach`, and `\\reach\\`. Found:

| File | Pattern found | Action taken |
|------|--------------|--------------|
| `src/config/config.ts` | `%APPDATA%\reach` in docstring + code | ✅ Updated docstring + simplified function |
| `src/bridge/pipeAuth.ts` | `%LOCALAPPDATA%\reach\bridge-auth.json` in docstring + `getAuthFilePath()` | ✅ Updated to use `getReachDataDir()` |
| `src/install/uninstall.ts` | `%LOCALAPPDATA%\reach` in comments, `LOCALAPPDATA` env var in two functions | ✅ Removed both; uses `getReachDataDir()` |
| `src/install/copyExtension.ts` | `%APPDATA%\GitHub Copilot\...` in docstring | ⏭️ Left untouched — this is the extension dir, not Reach state (explicitly out of scope per design doc §1) |

No additional hardcoded path strings found outside these four files.

---

## Cross-Platform / ADR-5 Confirmation

`os.homedir()` returns the correct user home directory on Windows when the daemon runs as a service per ADR-5 (service runs as the logged-in user account, not SYSTEM). When a named-user Windows service starts:
- `os.homedir()` → `C:\Users\<username>` (same as interactive shell)
- `APPDATA`, `LOCALAPPDATA`, and `USERPROFILE` are all populated by SCM

This is documented in Noble Six's design doc §7 and confirmed by `src/service/install.ts:11`. A dedicated service-context test is deferred to Phase 10 (noted in `history.md`).

---

## Files Changed

| File | Change |
|------|--------|
| `src/config/config.ts` | `getReachDataDir()` rewritten to `~/.reach/` + `REACH_DATA_DIR` override |
| `src/config/migrate.ts` | **New** — `migrateLegacyDataDir()` one-shot migration helper |
| `src/bridge/pipeAuth.ts` | `getAuthFilePath()` → `getReachDataDir() + '/bridge-auth.json'`; import added |
| `src/install/uninstall.ts` | `wipeLocalData()` targets `getReachDataDir()`; no-wipe hint updated; `LOCALAPPDATA` code removed |
| `src/install/index.ts` | `migrateLegacyDataDir()` called at start of `runInit()` |
| `src/main.ts` | `migrateLegacyDataDir()` called at start of `main()` |
| `tests/config/config.test.ts` | `getReachDataDir()` + `getConfigPath()` tests rewritten for new behaviour |
| `tests/config/migrate.test.ts` | **New** — migration unit tests (MIG1–MIG6) |
| `tests/install/uninstall.test.ts` | Updated for new path structure; UN10 added |

---
# Carter — PR #10 Cycle 4 Fix Decisions

**Wave:** Cycle 4 (PR #10, branch user/aaron/phase9)
**Date:** 2026-06-01
**Threads:** Thread 1 (uninstallService sync-throw timer leak), Thread 2 (hardcoded ~/.reach in no-wipe hint), Thread 3 (stale comment)

---

## Thread 1 — uninstallService sync-throw guard

**finish() helper:** Already existed from Cycle 3 (T2 fix). It calls `clearTimeout(timer)` then resolve/reject. I called it from the new catch block rather than refactoring inline — the helper already does all three required things (clears timeout, resolves/rejects). No refactor needed.

**Listener cleanup approach:** After `finish()` is called, `settled = true` is set before calling `finish()`, so all event handlers are neutered by the settled guard. Physical listener removal (`svc.removeListener`) was NOT added — the `ServiceInstance` interface does not expose `removeListener`, and the settled guard is sufficient. If physical removal is needed in the future, `ServiceInstance` must be extended.

**Mock impl leak fix:** SU tests set `mockSvcUninstall.mockImplementation(() => { throw ... })`. The outer `beforeEach` calls `vi.clearAllMocks()` (NOT `vi.resetAllMocks()`), which preserves mock implementations. Added `afterEach(() => { mockSvcUninstall.mockReset(); })` inside the `uninstallService()` describe block to prevent the throw impl from leaking into subsequent `main()` tests.

---

## Thread 2 — hardcoded ~/.reach in no-wipe hint

**Fix applied:** Line 114 in `src/install/uninstall.ts`. The `reachDir` variable was already resolved on line 111 via `getReachDataDir()`. Only the `Remove-Item` command line was hardcoded; the "Local state preserved" line (line 112) already used `reachDir`. Changed to template literal: `` `[reach]   Remove-Item -Recurse -Force "${reachDir}"` ``.

**Other hardcoded ~/.reach strings:** Grep across `src/**/*.ts` found other occurrences in:
- `src/config/config.ts` — JSDoc comments describing default dir. These are accurate descriptions of the *default*, not user-facing instructions. Left alone.
- `src/config/migrate.ts` — JSDoc/inline comments. Same reasoning. Left alone.
- `src/install/index.ts` — Migration comment. Describes legacy → new path. Left alone.
- `src/bridge/pipeAuth.ts` — JSDoc comment. Left alone.
- `src/install/uninstall.ts` JSDoc (`/** When true, also deletes ~/.reach/... */`) — This is describing the *default* behavior, not a runtime path. Left alone.

Only the **runtime user-facing console output** in the no-wipe branch was wrong.

---

## Thread 3 — stale comment

Comment at lines 100–101 in `src/install/uninstall.ts`. Old text claimed the service uninstaller "calls process.exit internally via node-windows events." Updated to accurately reflect the post-Cycle-3 architecture: uninstallService() returns a Promise, does not exit, and the orchestrator accumulates step results and exits at the end.

---
# Carter — PR #10 Cycle 5 Decisions

**Date:** 2026-06-01  
**Commit:** TBD (fix(pr10-cycle5): fail-closed wipe inspection + log service uninstall errors)

---

## 1. Other silent-catch patterns found in install/service code

### `src/config/migrate.ts:113` — non-fatal empty-dir removal

```ts
try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
```

**Context:** This runs only when `copied.length === 0` — the legacy dir is already empty. The rmSync here is a cosmetic cleanup (remove the now-empty shell). If it fails, the migration has already succeeded and no data was left behind. This is a legitimate best-effort swallow: failure is genuinely non-fatal and calling out specific error paths would only add noise to migration logs.

**Assessment:** Leave as-is. Not a safety bug. Unlike `wipeLocalData`, there is no risk of an unintended wipe because the directory is provably empty at this point.

### No other silent-catch patterns found in `src/install/` or `src/service/`.

---

## 2. Final error-logging format

The format chosen for service uninstall errors (in both the CLI shim and `main()`):

```
[reach] Service uninstall failed: <error.message>
```

### Rationale

- **`[reach]` prefix** — Consistent with every other user-facing message in the install/service domain. Makes it easy to grep logs and correlate with other output.
- **`Service uninstall failed:`** — Noun-phrase subject. Action-oriented. Distinguishes this from filesystem step failures in `runUninstall()` which use `ERROR:` or `WARNING:` prefixes.
- **`<error.message>`** — The raw message from the Error object. No wrapping, no JSON, just the text. Avoids double-quoting and keeps copy-paste debugging simple.

### Standardization recommendation for Aaron

If other install commands (e.g., `install()` CLI shim) ever gain similar error-propagation, use the same pattern:

```ts
.catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[reach] Service <action> failed: ${msg}`);
  process.exit(1);
});
```

Substitute `<action>` with `install`, `uninstall`, `start`, `stop`, etc.  
The consistent prefix makes it trivial to filter support logs: `grep '\[reach\] Service'`.

---

## 3. mockImplementationOnce pattern for fire-and-forget tests

When testing a `void`-returning function with an internal promise chain (fire-and-forget), and `process.exit` is mocked to throw globally, use `mockImplementationOnce` (not `mockImplementation`) to avoid leaking a non-throwing mock into subsequent tests. This pattern is now established and should be used whenever a similar fire-and-forget shim needs error-path testing.

---
# Carter — PR #10 Cycle 6 Decisions

**Date:** 2026-06-01  
**Branch:** user/aaron/phase9  
**Commit wave:** fix(pr10-cycle6)

---

## T1 — Orientation Race: Option A (flag-first, no catch rollback)

**Decision:** Set `binding.orientationSent = true` BEFORE `await safeSendMessage(...)`, and do NOT roll back on failure.

**Reasoning:**

- **Why A over B:** The race window only opens if we set the flag after the await. The callers check `!binding.orientationSent` and skip if already set; with flag-first, a second concurrent caller sees the flag immediately and skips — even while the first send is still in flight. Option B (rollback in catch) would reopen the race window on transient failures, which defeats the purpose of the guard.
- **On failure semantics:** `safeSendMessage` already swallows errors internally (logs a warning, never throws). Even if the send fails, the orientation state is conceptually "attempted for this AFK cycle." Retrying on the next `activate()` call after a failure would require a new AFK cycle, which resets `orientationSent` anyway. So keeping the flag true on failure is correct.
- **No retry-on-failure pattern found:** Searched the codebase — no pattern of rolling back state flags and retrying on transient errors in the AFK module. `withRateLimitRetry` covers rate-limit retries at the send layer, not flag rollback at the coordination layer.

---

## T2 — Double `[reach]` Prefix Audit

**Decision:** Strip `[reach]` from `Error.message` bodies in `src/service/install.ts`. The logger owns context.

**Single internal Error message with `[reach]` found and fixed:**

```
Line 346 (before): new Error('[reach] Service uninstall timed out after 60 s — uninstall event never fired')
Line 346 (after):  new Error(`Service uninstall timed out after ${UNINSTALL_TIMEOUT_MS / 1000} s — uninstall event never fired`)
```

**Audit result — other `[reach]` occurrences in install.ts:**  
All other `[reach]` occurrences are in `console.log`, `console.error`, and `console.warn` calls — these are correct (the logger adds context). There are NO other `new Error('[reach] ...')` patterns in `src/service/install.ts` or `src/install/*`.

The only violator was the timeout error message. The call-site `console.error('[reach] Service uninstall failed: ${err.message}')` correctly prefixes context at the boundary.

---

## Cluster 1 — redactSecrets Regex Final Shape

**Pattern change:** Added a 4th capture group `(["']?)` after the value in both KEYWORD_PATTERN and ENV_ASSIGNMENT_PATTERN to capture the optional trailing quote.

**KEYWORD_PATTERN (final):**
```
/\b(token|key|secret|...)\b(\s*[:=]?\s*['"]?)([A-Za-z0-9_\-.+/=]{16,})(["']?)/gi
```
Groups: `(keyword)(separator+openQuote)(value)(closeQuote)`

**ENV_ASSIGNMENT_PATTERN (final):**
```
/\b([A-Z][A-Z0-9_]*(?:TOKEN|...))\b(\s*=\s*['"]?)([^\s'"]{8,})(["']?)/g
```
Groups: `(varName)(separator+openQuote)(value)(closeQuote)`

**Replacement shape:**
```ts
(_match, kw, sep, _value, closeQuote) => `${kw}${sep}[REDACTED]${closeQuote}`
```

**Why independent `(["']?)` instead of backref `\3`:**
Conservative bias rule — false negatives (missed secrets) are worse than false positives. With backref, a mismatched-quote value (`token="secret'`) might fail to match and leak. With independent capture, the trailing character (whatever it is) is always consumed and re-emitted. Downstream pass 3 (HIGH_ENTROPY_PATTERN) provides an additional backstop.

**Mismatched quote behavior:** `token="abc123longvalue1234'` → value redacted, trailing `'` re-emitted as-is. Output is malformed like the input was — acceptable for a best-effort redactor.

---
# Carter — PR #10 Cycle 7 Decisions

**Date:** 2026-06-02  
**Branch:** user/aaron/phase9  
**Commit wave:** fix(pr10-cycle7)

---

## T1 — `src/config/migrate.ts`: win32 platform gate

**Decision:** Option (b) — explicit `if (process.platform !== 'win32') return;` at the
top of `migrateLegacyDataDir()`, before the `migrationAttempted` flag check.

**Rationale:**

Pre-Phase 8.5 Reach was Windows-only. The legacy paths (`%APPDATA%\reach\`,
`%LOCALAPPDATA%\reach\`) are Windows-specific constructs. There has never been a
Unix install of Reach: prior code used `process.env.APPDATA` which is undefined on
Unix, meaning the codebase would have crashed or produced no-op behavior. There is
no Unix legacy state to migrate FROM.

The Copilot reviewer's premise ("previous default was ~/.config/reach") is incorrect.
Pre-Cycle 3 code did not fall back to `~/.config/reach` — it used `process.env.APPDATA`
with a fallback to `path.join(os.homedir(), 'AppData', 'Roaming')` (a Windows path
convention even when APPDATA is unset). This fallback only makes sense on Windows.

**Why Option (b) over (a):** Option (a) (do nothing) leaves the function silently
inspecting `AppData\Roaming\reach` on a future Unix target, which would always be
absent but is confusing. Explicit gate + documentation makes the Windows-only
assumption clear to Phase 10 contributors. The comment explicitly warns: "When Phase
10 adds cross-platform support, there will be no legacy Unix paths to migrate FROM."
This prevents a future contributor from adding a `~/.config/reach` migration branch
without understanding that no such legacy state ever existed.

**Platform gate position:** Before `migrationAttempted` — this means on non-Windows,
the function returns without setting the flag. This is correct: the flag is only
meaningful for Windows execution flow, and returning before it is set does not create
double-call issues (the function is still a no-op on non-Windows regardless of how
many times it is called).

---

## T2 — `src/install/uninstall.ts`: `import 'dotenv/config'` added

**Decision:** Add `import 'dotenv/config'` as the first import in `uninstall.ts`.

**Rationale:**

`runUninstall()`/`wipeLocalData()` calls `getReachDataDir()`, which honors the
`REACH_DATA_DIR` environment variable. The daemon loads `.env` via `dotenv/config`
(in `src/main.ts`), but the uninstall script did not. A user with
`REACH_DATA_DIR=D:\custom\reach` in `.env` would find that `npm run uninstall -- --wipe`
deletes `~/.reach` (the default) instead of their actual state directory, because the
custom path was only in `.env` and never loaded.

This is a real data-integrity bug: the daemon has been writing to one directory and
the uninstall script is wiping a different one.

---

## T2 Audit — Sibling install entry points

**`src/install/index.ts` (`npm run init`):** ✅ ALSO FIXED.

`runInit()` calls `migrateLegacyDataDir()` → `getReachDataDir()`. If a user has
`REACH_DATA_DIR` in `.env` (e.g., an upgrade on a system with a custom data dir),
the migration would target `~/.reach` instead of the custom dir, potentially
failing to find or copy the legacy data to the right place. Added
`import 'dotenv/config'` as the first import.

Additionally, `runConfigWizard()` reads Telegram vars from `process.env` with
`readEnvFile()` as fallback. With `dotenv/config` loaded, `process.env` is already
populated from `.env` before the wizard runs. The wizard's `getVal()` function reads
`process.env` first anyway, so behavior is consistent — this doesn't change wizard
semantics, it just makes `REACH_DATA_DIR` (and any other process-level config in
`.env`) available through `process.env` uniformly.

**`src/install/copyExtension.ts` (`npm run install:extension`):** ✅ NOT needed.

`copyExtension()` does not call `getReachDataDir()`. It only uses:
- `process.env['APPDATA']` — Windows system env var, always in `process.env`, never in `.env`
- `process.env['NODE_ENV']` — set at CLI invocation (`NODE_ENV=development npm run ...`), not via `.env`

No `dotenv/config` added.

---

## Test coverage added

- **MIG7** (`tests/config/migrate.test.ts`): non-Windows platform mock (`process.platform = 'linux'`),
  asserts `existsSync` is never called — the gate fires before any fs access.
- **UN13** (`tests/install/uninstall.test.ts`): comment-level integration test note documenting
  the manual verification procedure. Unit-level assertion confirms the `vi.mock('dotenv/config')`
  stub is exercised (i.e., the import is present in the production module).
- **dotenv mock** added to both `tests/install/uninstall.test.ts` and `tests/install/index.test.ts`
  to prevent dotenv from attempting real `.env` reads during the test run.

---
# Carter — PR #10 Cycle 8 Decisions

**Date:** 2026-06-03  
**Branch:** user/aaron/phase9  
**Commit:** fix(pr10-cycle8): redactSecrets charset for JWT/base64 + defensive excerpt truncation

---

## T1 — HIGH_ENTROPY_PATTERN charset

**Final charset:** `[A-Za-z0-9_\-/+.=]{39,}`

Added `.` and `=` to the existing `[A-Za-z0-9_\-/+]` charset. This catches:
- JWT-shaped tokens (three `.`-separated base64url segments like `header.payload.sig`)
- Standard base64 strings with `=` or `==` padding

**Threshold:** Unchanged at 39+ characters (per cycle-2 docstring decision).

**False-positive analysis:**

Long URLs were the primary concern. Testing `https://example.com/very/long/path/with-many-segments`:
- The URL-creds pattern (pass 4) doesn't help here — it only matches `user:pass@host`.
- However, `https://example.com/very/long/path/with-many-segments` contains `:` and `/` but
  `https:` prefix — the scheme prefix `https:` and `:` are NOT in the charset, so the URL is
  naturally broken at the `:` character. The path segment after the host would need to be a
  single unbroken run of 39+ chars from the allowed charset to trigger HIGH_ENTROPY_PATTERN.
- Real path segments like `/very/long/path/with-many-segments` contain `/` (in charset) but
  also hyphens and mixed-case short words. A run like `/very/long/path` totals 15 chars —
  nowhere near 39.
- Only pathological cases like `https://host/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (a
  40-char lowercase run) would newly match. These are not realistic URL patterns in user prose.
- **Conclusion:** False-positive risk from the `.`/`=` addition is negligible. The module's
  conservative bias (false positives < false negatives) applies.

**Existing tests:** All 21 pre-existing redactSecrets tests continue to pass. URL fixture
`https://user:password@example.com/repo.git` is covered by the URL_CREDS_PATTERN (pass 4)
and the `example.com` host survives as expected.

**New tests added:** C8-1 (JWT token), C8-2 (base64 with `=` padding) — both in
`tests/bot/redactSecrets.test.ts`.

---

## T2 — MAX_EXCERPT_LENGTH location

**Decision:** Module constant in `src/bot/afkMode.ts`.

`protocol.ts` does not define a `MAX_EXCERPT_LENGTH` constant — the 500-char truncation is
only described in the JSDoc comment on `AfkRequestMessage.lastAssistantExcerpt`. Rather than
add a numeric export to the protocol file (which would mix wire-schema types with behavioral
constants), `MAX_EXCERPT_LENGTH = 500` is defined at the top of `afkMode.ts` where it is used.

If the protocol ever formalizes this constant (e.g., for extension-side enforcement parity),
it can be extracted to `protocol.ts` and imported here.

**Implementation:** Truncation applied at ingestion in the `afk.request` handler, before
`lastKnownExcerpts.set()`. Excerpts exceeding 500 chars are sliced and appended with `…`
(U+2026 HORIZONTAL ELLIPSIS). Excerpts of exactly 500 chars or fewer are stored unchanged.

**New tests added:** C8 truncation block in `tests/bot/afkMode.staleExcerpt.test.ts`:
- 600-char excerpt → truncated, `…` present in /status output
- 500-char excerpt → stored unchanged, no `…`
- 499-char excerpt → stored unchanged, no `…`

Test strings use short space-separated words (`'word '.repeat(n)`) to avoid the
HIGH_ENTROPY_PATTERN redacting the test values before they reach the display assertion.

---
# Carter — PR #10 Cycle 9 Decisions

**Date:** 2026-06-05  
**Branch:** user/aaron/phase9  
**Threads:** T1 (atomic legacy migration), T2 (excerpt truncation off-by-one)

---

## T1 — Atomic legacy migration (`src/config/migrate.ts:84-107`)

### Options considered

| Option | Description | Risk |
|--------|-------------|------|
| A | Atomic temp+rename per-dir | Cross-device rename concern on Windows; complex partial-cleanup path |
| B | Per-dir retry: remove early-return, check each legacy dir individually | Minimal; idempotent copy handles re-runs cleanly |
| C | Sentinel file `.reach-migration-complete` | More state to manage; doesn't address partial dir failure |
| D | Combine B + A | Most robust; added complexity justified only if cross-device risk is a concern |

### Decision: **Option B**

**Rationale:** The reported bug is precisely the early return `if (fs.existsSync(newRoot)) return;`. Removing it is sufficient — the existing per-dir loop already handles partial states correctly:
- `mkdirSync` with `{ recursive: true }` is a no-op if the dir already exists.
- Each legacy dir is checked for existence before attempting copy.
- If a legacy dir was already successfully migrated (and removed), it is absent from disk and simply skipped.
- Re-copying already-migrated files (overwrite) is harmless and idempotent.

Option D (temp+rename) would guard against mid-copy crashes, but on Windows a rename (MoveFile) within the same volume is atomic and would require a scratch dir under `newRoot`. Given Phase 8.5 scope and the low frequency of mid-copy crashes, this complexity is not justified. The retry path (Option B) closes the actual failure mode: a partial migration that left `newRoot` on disk with only some legacy dirs copied.

### Trade-offs / limitations

- A crash between `copyFileSync` and `rmSync` on a single file leaves the legacy dir intact, which is safe (next run re-copies, then removes).
- A crash between the last successful `rmSync` and process exit leaves no legacy dir and is fully clean.
- The `migrationAttempted` in-process flag still prevents double-migration within one process, which is correct and unchanged.

### Files changed

- `src/config/migrate.ts`: removed `if (fs.existsSync(newRoot)) return;`, updated doc comment.
- `tests/config/migrate.test.ts`: added MIG8 — partial migration retry scenario.

---

## T2 — Off-by-one in excerpt truncation (`src/bot/afkMode.ts:128-130`)

### Decision: apply `slice(0, MAX_EXCERPT_LENGTH - 1) + '…'`

`'…'` is one Unicode character (U+2026). The previous `slice(0, MAX_EXCERPT_LENGTH)` produced 500 chars then appended the ellipsis, storing 501 chars total — exceeding the documented 500-char protocol limit.

Fix: `slice(0, MAX_EXCERPT_LENGTH - 1)` = 499 chars + `'…'` = **500 chars**, matching the limit exactly.

### Files changed

- `src/bot/afkMode.ts`: off-by-one corrected.
- `tests/bot/afkMode.staleExcerpt.test.ts`: added `storedExcerpt.length ≤ 500` assertion to C8 truncation test.

---
# Decision: carter-pr10-stale-excerpt

**Date:** 2026-05-31
**Author:** Carter (Bridge Dev)
**Context:** PR #10, Copilot review comment on `src/bot/afkMode.ts:119-123`

## Decisions Made

### 1. Empty-string treated as absent (yes — recommended)

An `afk.request` with `lastAssistantExcerpt === ''` is treated identically to an
omitted excerpt. The `lastKnownExcerpts` map entry is **deleted**, not preserved.

**Rationale:** Redaction (`redactSecrets`) applied to an excerpt that consists
entirely of secrets produces `''`. Storing an empty string would still suppress
the "no excerpt" fallback path (`if (rawExcerpt)` is falsy), but would show
a blank `💬 Last from …:` line with no content. Deleting the key avoids this
display artifact and keeps the invariant: "a stored excerpt is always
non-empty and displayable."

The combined guard is: `if (lastAssistantExcerpt !== undefined && lastAssistantExcerpt !== '')`.

### 2. No consumer adjustment needed in `formatOrientationMessage` / `handleStatusCommand`

Both consumers reach `formatOrientationMessage`, which guards with:

```ts
const rawExcerpt = this.lastKnownExcerpts.get(binding.sessionId);
if (rawExcerpt) { ... }
```

After the fix, a deleted key returns `undefined`, which is falsy — the `💬`
block is correctly omitted with no consumer-side changes needed.

`handleStatusCommand` delegates entirely to `formatOrientationMessage` via
`safeSendMessage`; no further adjustment required there either.

## Fix Location

`src/bot/afkMode.ts:119-128` — `afk.request` handler in the constructor.

---
# Noble Six — State Storage Triage

**Date:** 2026-05-31T22:50:49-07:00
**Author:** Noble Six (Lead / Architect)
**Context:** PR #10 cycle 3 Copilot review findings T1/T3/T4/T5 — split state storage layout

---

## Recommendation

**Unify all Reach state under `~/.reach/` (`os.homedir()/.reach/`).**

- Single root, zero platform switches, cross-platform ready for Phase 10.
- `getReachDataDir()` becomes a one-liner: `path.join(os.homedir(), '.reach')`.
- `pipeAuth.ts` drops its independent `LOCALAPPDATA` path and reuses `getReachDataDir()`.
- `--wipe` simplifies to one `rmSync` on one directory.
- Cost: S (small) — ~25 LOC across 4 files, 1.5h implementation.

## Rationale

The split was unintentional (two authors, two defaults, no ADR). Today's layout puts durable state in `%APPDATA%` and transient state in `%LOCALAPPDATA%`. Neither roaming nor locality matters for a single-machine daemon. `~/.reach/` matches the dominant CLI tool pattern (`~/.aws/`, `~/.kube/`, `~/.docker/`) and works unchanged on macOS/Linux — the only option that avoids a Phase 10 rewrite of path logic.

## Would NOT Recommend

**Option B (unify under `%APPDATA%`)** — actively harmful. `bridge-auth.json` is per-machine transient state; roaming it via `%APPDATA%` would cause auth failures on multi-machine profiles. This is the only option with a correctness hazard, not just a style preference.

## Architectural Follow-Up for Phase 10

Regardless of which option is chosen:
1. **`REACH_DATA_DIR` env override** — Consider adding a `process.env.REACH_DATA_DIR` override (~3 LOC) for corporate environments with redirected home directories.
2. **Extension path** — The Copilot extension (`extension.mjs`) lives in `%APPDATA%\GitHub Copilot\...` — this is Copilot's tree, not ours. It stays where it is regardless of state root changes.
3. **XDG compliance** — The current `~/.reach/` recommendation is XDG-adjacent but not XDG-compliant (which would be `~/.local/share/reach/` for data, `~/.config/reach/` for config). Full XDG is overkill for a tool this small — revisit only if Reach grows to need cache/log separation.

---

Full design doc: `.copilot/reach-state-storage-design.md`

---

## Proposed / Pending Approval

> ⚠️ **These entries are DRAFT proposals awaiting Aaron's decision-gate approval. Do NOT treat as accepted decisions until explicitly approved.**

---

### PROPOSED ADR-DRAFT: Communications Channel Abstraction & Microsoft Teams Transport

**Status:** DRAFT — Pending Aaron's approval  
**Author:** Noble Six (Lead/Architect)  
**Date:** 2026-06-06  
**Inbox Reference:** `.squad/decisions/inbox/noble-six-comms-channel-abstraction-adr.md`

**Summary:** Proposes a phased approach to generalize Reach's hard-coupled Telegram integration:
- **Phase 1 (Open Repo):** Extract `ChannelPort` interface; refactor existing Telegram code into a `TelegramChannel` adapter. Zero behavior change.
- **Phase 2 (Corp Fork):** Implement `TeamsChannel` adapter using Microsoft Graph REST API. Developed in corp environment with corp Azure AD access.

**Key Decisions in Draft (requires Aaron approval):**
1. **Architecture:** Recommend Option A (Minimal Port Interface) for channel abstraction
2. **Teams Transport:** Recommend Graph REST API as primary (simpler, no HTTP server needed)
3. **Single Binary vs. Separate Builds:** Recommend single binary with `REACH_CHANNEL=telegram|teams` env var
4. **Formatting Ownership:** Recommend Option (a) — transport owns all formatting

**Open Questions for Aaron:**
- Graph API vs. Bot Framework as primary Teams transport?
- Single binary with channel switch or separate builds?
- How aggressively to generalize formatting?
- Can the corp fork `npm install` from the public GitHub repo?
- Is a publicly reachable webhook endpoint feasible in the corp environment?
- Does your corp tenant require admin consent for application permissions?
- Is AFK mode in scope for Teams Phase 2?
- Pairing flow for Teams?

**Full Document:** See `.squad/decisions/inbox/noble-six-comms-channel-abstraction-adr.md` (to be archived after approval).

---

### REFERENCE: Telegram/grammY Coupling Inventory for Teams Generalization

**Status:** Read-only reference  
**Author:** Carter (Bridge Dev)  
**Date:** 2026-06-06  
**Inbox Reference:** `.squad/decisions/inbox/carter-teams-channel-inventory.md`

**Summary:** Comprehensive file-by-file coupling map documenting:
- Direct grammY/Telegram imports across the codebase
- Telegram-specific concepts baked into message relay flow
- Session/topic ID assumptions (1:1 forum topic → session mapping)
- Config surface (env vars, config.json fields)
- Abstraction seams (where Teams adapter can plug in)
- Tangled coupling hotspots (requiring refactor for Teams support)

**Key Findings:**
- ✅ Good seams: Relay ports layer already abstracted; message formatting utils are pure functions
- ❌ Tangled coupling: Bot handlers (8 commands), AFK mode (300+ lines), session registry key type, MarkdownV2 hardcoding

**Reference Value:** This inventory is input to Noble Six's Phase 1 task breakdown (P1-2 through P1-5 in the ADR).

**Full Document:** See `.squad/decisions/inbox/carter-teams-channel-inventory.md` (reference archive).
