# Carter — History (Phase 1 Complete 2026-06-06, commit d84dc0c; Persona Review Cycle 2 PASSED 2026-06-07; Phase 2 Queued 2026-06-11)

---

**PHASE 2 KICKOFF (2026-06-11):** Phase 2 Teams adapter plan APPROVED by Aaron. Carter assigned to **P2a-2 (Teams env config)** and **P2a-3 (Teams adapter stub)** in Phase 2a (open repo, no corp access). P2a-2 adds `TEAMS_*` validation block to `parseEnv()`, extends `EnvConfig` interface with Teams-specific fields (teamsTenantId, teamsClientId, etc.), conditional on `reachChannel === 'teams'`. P2a-3 creates `src/channel/teams/index.ts` with `TeamsChannel` class, all methods stubbed (throw "not configured for live Graph"), capabilities declared (`supportsMessageEdit=false`, `supportsThreadCreation=false`, `supportsInteractivePrompts=false`, `supportsStreaming=false`, `maxMessageLength=28000`). P2a-3 passes conformance kit with `skipLifecycle: true`. Carter also assigned to P2b-2 (graphClient), P2b-3 (polling loop), P2b-4 (live wiring) in Phase 2b (corp fork, after corp access). Locked decisions: OD-1 (edit=false), OD-2 (poll 3s), OD-3 (I4 refactor-first), OD-4 (I5 defer).

**PHASE 1 COMPLETE + PERSONA REVIEW CYCLE PASSED (2026-06-07):** Shipped core rewire for channel abstraction. SessionEntry IDs migrated to strings (threadId, channelId); TelegramChannel adapter implements ChannelPort interface with full capability descriptor; relay refactored onto ChannelPort with capability-aware branching; startup wiring complete for REACH_CHANNEL env var. **Two-cycle persona review completed:**
- **Cycle 1 findings:** 3 blocking, 5 important, 4 minor
- **Carter fixes (Cycle 1, 58e1326):** R1 (cfg-factory), B1 (relay de-duck-type), B2 (AFK guard), I1 (conditional creds), I2 (boolean return)
- **Carter fixes (Cycle 2, 5b6d30c):** I1-residual (allowed-user gating), N1 (formatForTransport docstring)
- **Cycle 2 outcome:** 0 blocking, all 6 prior important findings verified resolved by all Code Panel personas
- **Final test count:** 963 green (+17 from Jun's regression tests, all passing). tsc+lint clean.
- **Ship status:** READY FOR /ship-to-pr
- **Deferred to Phase 2:** I4 (optional createThread), I5 (ChannelMessage union), M5 (central mock factory)

F1 blocker fixed in commit e1f3f4d; verified by Jun in commit 2b5e4a2. Reference: Phase 1 section in decisions.md; orchestration log at .squad/orchestration-log/2026-06-07-persona-review-phase1.md. Next: Teams Phase 2 pending corp access.

---

## Learnings

### F1 Fix — Relay Capability Branching (2026-06-06, commit e1f3f4d)

Noble Six's Phase 1 review caught that the relay always sent a `"…"` placeholder
and called `editMessage` on every 800ms throttle tick regardless of capability
flags — violating the `ChannelPort` contract for channels like Teams where
`supportsStreaming=false`.

**Fix approach:** replaced the single monolithic streaming block with an
explicit three-case branch keyed on `channel.capabilities`:

- **Case A** (`supportsStreaming && supportsMessageEdit`): byte-identical to the
  pre-fix Telegram path. No behavior change, confirmed by 937 green tests.
- **Case B** (`!supportsMessageEdit`): no placeholder, silent accumulation,
  single `sendMessage` with the complete response. `editMessage` is never
  reached — the code path to it doesn't exist in this branch.
- **Case C** (`!supportsStreaming`, `supportsMessageEdit=true`): `"thinking…"`
  placeholder, full accumulation, single `safeEditFormatted` at the end. No
  intermediate edits at all.

Error paths updated symmetrically: Case B uses `sendMessage` for the error
message (no placeholder to edit); Cases A and C edit the placeholder.

**Key lesson:** when a port contract specifies per-capability fallback behaviors,
the consumer (relay) must gate every optional-method call on the flag — not
assume the adapter will silently swallow calls it doesn't support. The
conformance test kit validates adapter behavior; the relay capability tests
(owned by Jun) validate that the relay *calls the right methods given the flags*.

### Cycle-1 Fixes — cfg-into-factory + relay de-duck-typing (2026-06-06, commit 58e1326)

**R1 — factory must use resolved cfg, not raw env.**  
The Telegram adapter's self-registration factory was reading `process.env.TELEGRAM_BOT_TOKEN`
and `process.env.TELEGRAM_CHAT_ID` directly, bypassing the already-resolved `EnvConfig`.
Paired installs (chatId stored in config.json, env unset) worked at the `parseEnv()` level
(cfg.chatId resolved from config) but broke silently at the factory: chatId defaulted to 0
because the env var was absent.

**Fix:** `ChannelFactory` now takes `(cfg: EnvConfig) => ChannelPort`; `createChannel(name, cfg)`
threads the resolved config to the factory. The Telegram factory reads `cfg.token` and
`cfg.chatId` — the pre-resolved values — restoring the pre-refactor `createBot(cfg.token, cfg.chatId)` behavior exactly.

**Lesson:** when a refactor lifts credential resolution into a config layer, all downstream
consumers must be updated to read from that layer. Leaving one consumer (the factory) reading
from the raw source creates a regression path that only manifests for non-default config
shapes (paired install).

**B1 — relay de-duck-typing (remove TelegramChannel leak).**  
Replaced `asTelegramChannel()` duck-type check + `editMessageWithMarkdown`/`sendMessageWithMarkdown`
wrappers with uniform `channel.sendMessage(ctx, rawText)` / `channel.editMessage(ctx, ref, rawText)`
calls for all transports. The adapter (TelegramChannel) owns formatting internally per contract.
The deprecated `*WithMarkdown` public wrappers on TelegramChannel were also removed.

Simplified private helpers `safeEdit(ctx, ref, text)` and `safeSend(ctx, text, ...)` wrap the
direct calls in try/catch and return boolean — no Telegram special-casing anywhere in core.


`registerChannel`'s factory had `const { Bot } = require('grammy') as typeof import('grammy')` inside it. The comment said it was deferring grammY's load until the factory runs. There was NO circular dependency — registry.ts only imports `type { ChannelPort }` and never touches the telegram module. The defer was pure premature optimisation. Fixed by promoting `Bot` from the type-only import to a value import (`import { Bot, type Context } from 'grammy'`) and deleting the 3-line require block. tsc, lint, vitest all green; test count unchanged at 946.

### Cycle-2 Cleanup — I1-residual, N1, minors (2026-06-06, commit 5b6d30c)

When making multiple related edits to the same file in one response, include sufficient surrounding context in each `old_str` to avoid accidentally truncating adjacent code (e.g., the inner `try` block inside an outer `try` was dropped on first attempt). Verify with `view` after each structural edit before moving on.

### PR #11 Copilot Review — registry empty-id guard + topic→thread terminology (2026-06-07, commit f4baf17)

`?? ''` fallbacks in `load()` silently accepted corrupt entries: pre-computing `threadId`/`channelId` via `coerceId` before building the object and `continue`-ing on falsy results is safer than building-then-validating, because the object literal is never constructed with a bad state. `validateEntry`'s empty-string check is a second defence-in-depth layer, not the primary gate.

### PR #11 Round-2 Copilot Review — key-mismatch, chatId fast-fail, neutral log, NaN guard (2026-06-08, commit e619f00)

Permissive "numeric key" branch in `load()` let mismatched entries silently re-key and overwrite real entries; removing the second AND-condition makes the rule uniform. Defaulting `chatId` to `0` in the factory produced a silent dead daemon — fail-fast with a clear Error is always safer than a default that accepts invalid state. `Number('abc') === NaN` is not `undefined`, so any guard on `!== undefined` must also check `Number.isFinite` before using the value as a Telegram API integer. Startup logs should use the transport-neutral `channel.name` so the message stays accurate when non-Telegram adapters are added.
- PR #11 round-3 (2026-06-09): introduced 	oTelegramTopicId() as a single shared helper (threadId → message_thread_id guard, NaN-safe) to replace scattered Number(ctx.threadId) conversions; added isValidTelegramChatId() in env.ts so the config.telegramChatId path applies the same integer/non-zero constraints as the env-var path, preventing silent bad-chatId acceptance.
- PR #11 round-4 (2026-06-09): tightened toTelegramTopicId() to positive-integer-only (Number.isInteger(n) && n > 0), rejecting '0', whitespace, negatives, and non-integers that Number.isFinite() previously accepted; doc-only fix to port.ts supportsInteractivePrompts=false note to reflect that the adapter owns the text-fallback in promptUser(), not the core.
- PR #11 round-5 (2026-06-09): log 'Channel starting' BEFORE await channel.start() and 'Channel started' AFTER it resolves — "started" should only print when startup actually succeeded, not before it completes.
- PR #11 round-6 (2026-06-09): added validateEntry() guards on register() and move() write paths — fail-fast with a clear Error before persisting, symmetric with the load-path guard; prevents invalid entries from reaching disk and being silently dropped on next load().

### P2a-2 + P2a-3 — Teams env config and adapter stub (2026-06-10, commit 1b4862a)

**TEAMS_* env var names (P2a-2):**
- `TEAMS_TENANT_ID` → `cfg.teamsTenantId` — Azure AD tenant ID
- `TEAMS_CLIENT_ID` → `cfg.teamsClientId` — Azure AD application (client) ID
- `TEAMS_CLIENT_SECRET` → `cfg.teamsClientSecret` — Azure AD client secret
- `TEAMS_TEAM_ID` → `cfg.teamsTeamId` — Teams team ID (GUID); needed for Graph endpoint /teams/{team-id}/channels/{channel-id}/messages
- `TEAMS_CHANNEL_ID` → `cfg.teamsChannelId` — Teams channel ID within the team

All five fields are type `string | undefined` (required properties, NOT optional `?`) in `EnvConfig`. They are populated only when `reachChannel === 'teams'`; otherwise remain `undefined`. Validation uses the same fail-fast `[reach] Fatal:` pattern as the Telegram block.

**File paths:**
- `src/config/env.ts` — EnvConfig interface extended + parseEnv() Teams block
- `.env.example` — Teams section added (all five vars documented with comments)
- `src/channel/teams/index.ts` — TeamsChannel class + self-registration
- `src/main.ts` — `import './channel/teams/index.js'` side-effect import added
- `tests/integration/main-composition.test.ts` — added `vi.mock` for teams index to suppress registerChannel during registry mock

**TeamsChannel capability descriptor (P2a-3):**
```
supportsMessageEdit:       false   (OD-1)
supportsThreadCreation:    false   (I4 optional method — createThread is OMITTED entirely)
supportsInteractivePrompts: false  (text-fallback; Adaptive Cards in Phase 2b)
supportsStreaming:          false   (OD-2)
maxMessageLength:          28000
```

**Stub method list and behavior:**
- `start()` → throws `Error('[teams] not configured for live Graph')` — Phase 2b wires Graph polling
- `stop()` → resolves (no-op; no connection in stub mode)
- `sendMessage(ctx, text)` → returns `{ id: String(++counter) }` — in-memory, no Graph call
- `editMessage(ctx, ref, text)` → returns `false` — supportsMessageEdit=false
- `formatForTransport(markdown)` → identity (returns input unchanged)
- `splitMessage(text, footer?)` → character-boundary split at maxMessageLength (28000)
- `promptUser(ctx, question, options, signal?)` → text-fallback: sends question+options as plain text, waits for matching inbound text or abort
- `onMessage(handler)` → stores handler
- `onCommand(command, handler)` → stores in Map
- `dispatchInboundMessage(ctx, text)` → internal: resolves pending prompt or fires message handler (Phase 2b polling will call this)
- `dispatchInboundCommand(command, ctx, args)` → internal: dispatches to registered command handler
- NO `createThread()` — omitted per I4 optional-method contract (supportsThreadCreation=false)

**promptUser signature (for Kat, P2a-5 text fallback):**
```typescript
async promptUser(
  ctx: ChannelContext,
  question: string,
  options: readonly PromptOption[],
  signal?: AbortSignal,
): Promise<string>
```
The stub sends `question + "\n\nOptions:\n" + option lines` via sendMessage, then waits. `dispatchInboundMessage` resolves the pending prompt when text matches an option value.

**registerChannel pattern:**
```typescript
registerChannel('teams', (cfg) => {
  if (!cfg.teamsTenantId || !cfg.teamsClientId || !cfg.teamsClientSecret) {
    throw new Error('[teams] TEAMS_TENANT_ID, TEAMS_CLIENT_ID, and TEAMS_CLIENT_SECRET are required when REACH_CHANNEL=teams');
  }
  if (!cfg.teamsTeamId || !cfg.teamsChannelId) {
    throw new Error('[teams] TEAMS_TEAM_ID and TEAMS_CHANNEL_ID are required when REACH_CHANNEL=teams');
  }
  return new TeamsChannel();
});
```

**exactOptionalPropertyTypes gotcha:** `src/` is checked with `exactOptionalPropertyTypes: true`. Assigning `= undefined` to an optional property (`?`) fails. Use `delete this.prop` instead. FakeChannel.ts (in tests/) avoids this because tests are excluded from tsconfig.

**main-composition.test.ts pattern:** When adding a side-effect import to main.ts that calls `registerChannel`, the integration test that mocks `registry.js` without `registerChannel` will fail. Fix by adding `vi.mock('../../src/channel/teams/index.js', () => ({}))` alongside the existing Telegram mock.

### PR #12 Copilot Review — splitMessage invariant + promptUser registration ordering (2026-06-11, commit 990f94b)

**splitMessage footer-invariant fix:**  
The old code had `bodyCapacity = Math.max(1, max - footerReserve)` which bottomed out at 1 when `footerReserve >= max`. Appending `separator + footer` to the last body chunk then produced a chunk of length `1 + footerReserve >= max + 1`, violating the each-chunk<=maxMessageLength invariant. Fix: gate on `footerReserve >= max`; when true, split body at `max` normally and then split the footer block (`separator + footer`) into its own `max`-sized chunks, appending them after all body chunks. The common-case path (footer fits) and no-footer path are unchanged.

**promptUser register-before-send ordering fix:**  
The old code `await this.sendMessage(...)` before `this.pendingPrompts.set(key, entry)`. Any inbound reply or abort signal that arrived during the sendMessage round-trip would find no pending entry and be silently lost. Fix: move the `pendingPrompts.set` and abort handler registration into the `new Promise` constructor (which runs synchronously), BEFORE `sendMessage` is called. `sendMessage` is called without `await` inside the constructor; a `.catch` handler cleans up the entry and resolves `''` if send fails. All four settlement paths (match, abort, overwrite, pre-abort) remain intact.



**Prompt state map key format:** `${ctx.channelId}:${ctx.threadId}` — both fields are `readonly string` on `ChannelContext`. The key is computed at the top of `promptUser` and `dispatchInboundMessage`; it scopes pending prompts so replies on context A never resolve a prompt on context B.

**PendingPromptEntry stores signal + abortHandler** so the overwrite path can call `prior.signal?.removeEventListener('abort', prior.abortHandler)` before resolving the prior promise with `''`. Without this the abort listener would remain registered on the prior signal; with `{ once: true }` it would fire as a no-op guarded by the identity check, but removing it eagerly is cleaner and explicitly requested.

**No-unsettled-promise guarantee:** four paths exist for each map entry:
1. **Match** — `dispatchInboundMessage` deletes the entry and calls `resolve(value)`.
2. **Abort** — `{ once: true }` handler checks `pendingPrompts.get(key) === entry` (guards against a race where match fires first), deletes, calls `resolve('')`.
3. **Overwrite** — new `promptUser` call for the same key deletes prior entry, removes its abort listener, calls `prior.resolve('')` synchronously before the await.
4. **Pre-abort** — `signal?.aborted` fast-path at method entry returns `''` immediately; no entry ever enters the map.

**splitMessage footer-reserve behavior:** two distinct paths when a footer is present and the combined length exceeds `maxMessageLength`:
1. **Footer fits** (`footerReserve < max`, where `footerReserve = separator.length + footer.length`): body capacity is reduced to `max - footerReserve`; the body is chunked at that capacity and the footer (with separator) is appended to the **last body chunk only**.
2. **Footer does not fit** (`footerReserve >= max`): the body is chunked at `max` without any footer reserve, then the footer block (`separator + footer`) is chunked separately at `max` and appended as additional chunks. This guarantees every chunk satisfies `chunk.length <= max` even when the footer alone exceeds `maxMessageLength`.
When no footer is present the original character-boundary split at `max` runs unchanged. When the combined length fits in one chunk, a single-element array is returned immediately.

