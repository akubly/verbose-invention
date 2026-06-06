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
