> 📦 Entries older than 2026-05-30 archived to decisions-archive-2026-06-06.md on 2026-06-06.

### Phase 1: Abstraction + Telegram Refactor (Open Repo)

**Goal:** Extract `ChannelPort` interface with capabilities descriptor and transport registry; refactor existing Telegram code into a `TelegramChannel` adapter. Zero behavior change — all existing tests pass.

| Item | Owner | Description | Blocked? |
|------|-------|-------------|----------|
| P1-1: Define `ChannelPort` interface + `ChannelCapabilities` | Noble Six | Core port in `src/channel/port.ts`: interface, capabilities descriptor, `MessageRef`, `ChannelContext`, `PromptOption`. Design for N transports. | No |
| P1-2: Transport registry | Noble Six | `src/channel/registry.ts`: `Map<string, ChannelFactory>`, `registerTransport()`, startup selection via `REACH_CHANNEL`. Wire into DI root. | No |
| P1-3: Generalize `SessionEntry` | Carter | `topicId` → `threadId: string`, `chatId` → `channelId: string`; update registry, types, all consumers. Registry migration for existing JSON files (numeric → string). | No |
| P1-4: Refactor relay to use `ChannelPort` | Carter | `Relay` class takes a `ChannelPort` instead of `grammY.Context`. Core checks `capabilities` before calling optional features (edit, streaming, interactive prompts). Formatting/splitting delegated to adapter. | No |
| P1-5: Create `TelegramChannel` adapter | Kat | Wraps grammY Bot behind `ChannelPort`. Owns MarkdownV2 escaping, 4096-char splitting, inline keyboards. Capabilities: `{ supportsMessageEdit: true, supportsThreadCreation: true, supportsInteractivePrompts: true, supportsStreaming: true, maxMessageLength: 4096 }`. | No |
| P1-6: Refactor handlers/commands | Kat | Command handlers use `ChannelPort.onCommand()` instead of `bot.command()`; formatting uses adapter. | No |
| P1-7: Conformance test kit | Jun | **Reusable** test suite that ANY `ChannelPort` implementation must pass. Tests organized by capability: (a) mandatory tests (send, receive, split, format), (b) conditional tests gated on capabilities (edit, streaming, interactive prompts, thread creation). Future adapters (Slack, Discord, Teams) run this same kit. | No |
| P1-8: Config generalization | Carter | Add `REACH_CHANNEL=telegram` env var (default). Keep `TELEGRAM_*` vars valid when channel=telegram. Prepare `REACH_CHANNEL=teams` path (stub adapter). | No |
| P1-9: Regression suite | Jun | Ensure 570+ existing tests pass with zero behavior change. | No |
| P1-10: ADR finalization | Noble Six | Lock this ADR after Aaron's final approval. | No |

### Phase 2: Teams Adapter (Corp + Open Repo)

**Goal:** Implement `TeamsChannel` adapter using Graph REST API with polling for inbound. Developed and validated in corp environment.

| Item | Owner | Description | Blocked? |
|------|-------|-------------|----------|
| P2-1: Teams adapter stub | Carter | Stub in open repo satisfying `ChannelPort` with capabilities `{ supportsMessageEdit: true, supportsThreadCreation: false, supportsInteractivePrompts: true, supportsStreaming: false, maxMessageLength: 4096 }`. Throws "not configured" at runtime. Passes conformance kit mandatory tests against mock. | No |
| P2-2: Azure AD app registration + admin consent | Corp-side | Register app in corp tenant. Client-credentials flow. Permissions: `Chat.ReadWrite`, `ChannelMessage.Send`, `ChannelMessage.Read.All`. **One-time admin consent required.** | **Yes** — corp access |
| P2-3: Graph polling client | Corp-side | `GET /messages` with `$filter` at ~2s intervals. Parse inbound messages, dispatch to `onMessage` handlers. Budget: ~0.5 req/sec for polling, ~1.5 req/sec for outbound. | **Yes** — corp access |
| P2-4: Graph send/edit client | Corp-side | `POST` to create messages, `PATCH` to edit. Rate-limit-aware with retry/backoff. | **Yes** — corp access |
| P2-5: Teams formatting | Kat (+ corp) | `formatForTransport()` producing HTML or Adaptive Card JSON. Design in open repo (adapter-internal module), validate in corp. | Partially |
| P2-6: Permission prompt via Adaptive Cards | Kat (+ corp) | Adaptive Card action buttons replacing Telegram inline keyboards. Falls back to text prompt if `supportsInteractivePrompts` is ever set false. | **Yes** — corp testing |
| P2-7: Streaming UX validation | Noble Six + corp | Start with S1 (no streaming edits). Test S2 (Adaptive Card refresh) if time permits. Inform `supportsStreaming` capability. | **Yes** — corp access |
| P2-8: AFK mode generalization | Carter | Generalize `AfkModeController` or make it adapter-internal. Core exposes hooks; Telegram adapter uses them for forum-topic AFK. Teams adapter defers AFK to Phase 3 if complex. | No (design), **Yes** (Teams validation) |
| P2-9: Integration testing | Jun (+ corp) | Conformance kit run against live Teams adapter in corp environment. | **Yes** — corp access |
| P2-10: Config/env for Teams | Carter | `REACH_CHANNEL=teams`, `TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_CHANNEL_ID`. | No |

---

## 6. Open Questions for Aaron

Questions answered in v2 review are struck through. Remaining + new questions below.

### Answered (v2)

- ~~Single binary vs separate builds~~ → **Single binary with `REACH_CHANNEL` switch** (D1)
- ~~Formatting strategy~~ → **Transport-owns** (D2)
- ~~Can corp fork npm install from public repo~~ → **Yes** (D4)
- ~~Webhook endpoint feasible~~ → **No; polling** (D5)
- ~~Admin consent required~~ → **Yes; client-credentials + admin consent** (D6)

### Remaining from v1

1. **Is AFK mode in scope for Teams Phase 2?** AFK mode is deeply Telegram-specific (forum topic creation, orientation messages, stream routing). Recommend deferring Teams AFK to Phase 3, keeping Phase 2 focused on basic relay. **Decision needed.**

2. **Pairing flow for Teams?** Telegram pairing uses a one-time code sent to the bot. Teams would need a different onboarding flow (e.g., configure channel ID via env var, authenticate via browser). **Phase 2 or later?**

### New Questions (from N-Transport Direction)

3. **Which transports are on the horizon, and in what priority order?** You mentioned Slack and Discord as possibilities. Knowing the priority helps us validate the capabilities descriptor against real transport APIs now rather than discovering gaps later. Is it Teams → Slack → Discord, or different?

4. **Should the transport registry support runtime switching, or is startup-only selection sufficient?** Current design: `REACH_CHANNEL` is read once at startup; changing transport requires a daemon restart. If you envision switching transports without restart (e.g., for failover or multi-channel), the registry and relay need different wiring. **Startup-only is simpler and recommended** — a personal daemon restart is cheap.

5. **Graph API vs. Bot Framework: final call?** v1 recommended Graph API (primary) + Bot Framework (fallback). Corp constraints (no webhook endpoint, admin consent available) reinforce Graph as primary. But if corp IT has existing Bot Framework infrastructure or prefers the bot registration model, that changes the calculus. **Is Graph API confirmed as primary, or do you need to check with corp IT first?**

6. **Conformance kit scope — how strict?** The conformance test kit (P1-7) defines the behavioral contract for ALL adapters. Options:
   - **(a) Interface compliance only** — tests that the adapter implements all methods, returns correct types, handles capabilities correctly.
   - **(b) Behavioral contract** — tests that messages round-trip correctly, formatting produces valid output for the platform, prompts resolve, etc. (heavier but catches more bugs).
   
   Recommend **(b)** — the conformance kit is the primary quality gate for new adapters.

---

## Appendix: Telegram Coupling Inventory

Files with direct Telegram/grammY dependencies that Phase 1 must address:

| File | Coupling Type | Refactoring Needed |
|------|--------------|-------------------|
| `src/types.ts` | `topicId: number`, `chatId: number` | Generalize to `threadId: string`, `channelId: string` |
| `src/bot/index.ts` | `grammY.Bot` constructor, chat ID guard | Move behind `TelegramChannel` adapter |
| `src/bot/handlers.ts` | `grammY.Context`, `bot.command()`, `ctx.reply()` | Rewrite against `ChannelPort` |
| `src/bot/commands.ts` | Telegram command format (`/foo`) | Keep as-is (Teams also uses `/foo` style) |
| `src/bot/prompt.ts` | Inline keyboards, `callback_query` | Move behind adapter's `promptUser()` |
| `src/bot/pairing.ts` | Telegram-specific pairing flow | Keep in `TelegramChannel`; stub for Teams |
| `src/bot/afkMode.ts` | Forum topics, orientation messages | Generalize or defer to Phase 3 |
| `src/bot/afkStreamRouter.ts` | Telegram message sending | Generalize with `ChannelPort` |
| `src/relay/relay.ts` | `grammY.Context`, MarkdownV2, 4096 limit | Core relay uses `ChannelPort`; formatting delegated |
| `src/relay/markdownV2.ts` | Pure Telegram | Moves into `TelegramChannel` adapter |
| `src/relay/messageSplitter.ts` | 4096-char limit | Moves into `TelegramChannel` adapter |
| `src/relay/ports.ts` | `topicId: number`, `chatId: number` | Generalize to string IDs |
| `src/sessions/registry.ts` | `topicId: number`, `chatId: number` in persistence | Generalize; migration for existing registry files |
| `src/config/env.ts` | `TELEGRAM_BOT_TOKEN`, etc. | Add channel-switch logic; keep Telegram vars valid |
| `src/main.ts` | DI root wires grammY Bot directly | Channel selection at DI root based on `REACH_CHANNEL` |

---

*This is a DRAFT v2 ADR. Decisions D1–D7 are locked per Aaron's review. Remaining open questions in §6 require decisions before implementation. No code changes until Aaron gives final approval.*



---

### Concurrent Review — Noble Six Phase 1 Architectural Review

# Noble Six — Phase 1 Architecture Review

**Date:** 2026-06-06  
**Reviewer:** Noble Six (Lead/Architect)  
**Branch:** `feature/channel-abstraction`  
**Commits reviewed:** d84dc0c (Carter), e69e50b (Kat), 3739640 (Jun)  
**Prior commit (contract):** 7b12305 (Noble Six)

---

## VERDICT: APPROVE-WITH-NITS

The branch is sound. The core abstraction is clean, the Telegram adapter preserves existing behavior, the conformance kit is genuinely behavioral, and the 937-test suite is green. The contract is Teams-ready with one required tweak and several non-blocking items.

---

## 1. Contract Cleanliness / Abstraction Leaks

### ✅ Port contract (`src/channel/port.ts`) — Clean

No Telegram-isms. All IDs are opaque strings. Capabilities descriptor is well-typed. TSDoc specifies fallback behaviors. The interface is exactly what I designed in P1-1. No modifications were needed by Carter or Kat.

### ⚠️ NIT N1: `setMessageInterceptor` on TelegramChannel — Acceptable Phase-1 Debt

`TelegramChannel.setMessageInterceptor(fn: (ctx: Context) => Promise<boolean>)` is a Telegram-specific method that lives OFF the port contract. It's used by `main.ts` to inject the AfkModeController's `handleTelegramMessage` before the `onMessage` handler fires.

**Judgment: Acceptable.** AFK mode is deeply Telegram-specific today (forum topic creation, orientation messages, stream routing). Generalizing it would bloat Phase 1 without delivering value — Teams doesn't need AFK mode yet. The interceptor is on the concrete class, not the port. No abstraction leak.

**Future path (P2/P3):** When AFK mode is generalized, the interceptor should become a port-level concept — something like `onMessageFilter(predicate)` that runs before the `onMessage` handler. Not blocking.

### ⚠️ NIT N2: Synthetic grammY `Context` for `/status` and `/cwd` — Acceptable Phase-1 Debt

`handlers.ts` creates a `makeSyntheticCtx(channelCtx)` that builds a fake grammY `Context` object for two commands:
- `/status` → calls `statusProvider.handleStatusCommand(syntheticCtx)` which accepts grammY `Context`
- `/cwd` → calls `handleCwdCommand(syntheticCtx, ...)` which accepts grammY `Context`

The synthetic ctx routes `reply()` calls through `channel.sendMessage()`. It works, and Jun pinned it with regression tests. But it's a compatibility shim, not a clean abstraction.

**Judgment: Acceptable.** Both `handleStatusCommand` and `handleCwdCommand` accept grammY `Context` because they're deep functions that weren't worth refactoring in Phase 1. The shim preserves behavior without changing internal APIs. But it means two commands still have an indirect Telegram dependency path.

**Future path (Phase 2 or backlog):** Refactor `handleCwdCommand` and `handleStatusCommand` to accept `ChannelPort + ChannelContext` instead of grammY `Context`. This eliminates the shim. **Owner: Kat** (owns handler layer). Non-blocking.

---

## 2. N-Transport Readiness (Teams)

### Could a Teams adapter implement `ChannelPort` AS WRITTEN?

**Yes, with one required change and one advisory.**

### 🔴 FINDING F1: Relay does NOT check `supportsMessageEdit` or `supportsStreaming` before calling `editMessage` — MUST FIX

This is a real contract violation in `relay.ts`. The port TSDoc states:

> Core MUST check capabilities.supportsMessageEdit before calling [editMessage].
> Core MUST NOT call editMessage() [when supportsMessageEdit is false].

But `relay.ts` lines 113–119 call `channel.editMessage()` during streaming without checking capabilities:

```typescript
if (now - lastEditAt >= STREAM_EDIT_THROTTLE_MS) {
  try {
    await this.channel.editMessage(channelCtx, placeholderRef, accumulated);  // ← no capability check
  } catch { ... }
}
```

And line 100 always sends a placeholder:
```typescript
const placeholderRef = await this.channel.sendMessage(channelCtx, '…');  // ← always sent, even when no edits will follow
```

For a Teams adapter with `supportsStreaming: false` and `supportsMessageEdit: true`, the relay would:
1. Send a "…" placeholder (wasteful but harmless — would be replaced by final edit)
2. Call `editMessage` during streaming at 800ms intervals (violates `supportsStreaming: false`)
3. Call `safeEditFormatted` for the final response (correct)

For a hypothetical adapter with `supportsMessageEdit: false`, the relay would:
1. Send a "…" placeholder that can never be edited (user sees "…" forever if first-chunk edit fails)
2. Call `editMessage` during streaming — returns false but wastes API calls
3. Call `safeEditFormatted` → falls back to `formatForTransport + editMessage` → fails

**Required fix:** Before the streaming loop, check `channel.capabilities.supportsStreaming`. If false, skip intermediate edits entirely. Before the placeholder send, check `supportsMessageEdit` — if false, don't send a placeholder; accumulate the full response and send once at the end. The fallback paths are documented in the port TSDoc; they just aren't implemented in the relay yet.

**Owner: Carter** (owns relay). **Blocking: YES** — the relay must honor the contracted fallback behaviors before the port is Teams-ready. Without this, a `supportsStreaming: false` adapter would fire dozens of pointless `editMessage` calls per response.

### ⚠️ NIT N3: `asTelegramChannel()` duck-typing in relay — Non-blocking but needs a plan

`relay.ts` duck-types to `TelegramChannel` for `editMessageWithMarkdown` and `sendMessageWithMarkdown`:

```typescript
private asTelegramChannel(): TelegramChannel | null {
  const ch = this.channel as unknown as TelegramChannel;
  return typeof ch.editMessageWithMarkdown === 'function' ? ch : null;
}
```

This is documented as intentional (Carter's handoff notes). For Telegram, it preserves the MarkdownV2-with-plain-fallback behavior. For non-Telegram channels, it falls through to the generic `formatForTransport + editMessage` path.

**Judgment: Acceptable for Phase 1.** The duck-typing doesn't break any other adapter — it's a transparent optimization for Telegram. But it means the generic path (`formatForTransport + editMessage`) is exercised only in tests, never in production for Telegram. This is a minor test-coverage gap.

**Future path:** When a second adapter goes live, the generic path gets real production exercise. No action needed now.

### ⚠️ NIT N4: `require('grammy')` in factory registration — Lint suppression

Line 288 of `src/channel/telegram/index.ts`:
```typescript
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Bot } = require('grammy') as typeof import('grammy');
```

This uses CJS `require()` in an ESM module to "lazily" import grammY. The intent is to avoid loading grammY when `REACH_CHANNEL !== 'telegram'`. But the module is imported via `import './channel/telegram/index.js'` in `main.ts`, which runs the side-effect registration AND parses the factory function at module load. The `require()` inside the factory only defers the actual grammY load until `createChannel('telegram')` is called — which is always called when `REACH_CHANNEL === 'telegram'`.

**Judgment: Non-blocking nit.** The lazy load works as intended for the case where a Teams user never calls `createChannel('telegram')`, but the CJS `require()` in ESM is a code smell. Replace with dynamic `await import('grammy')` or just use a static top-level import since the module is only imported when Telegram is selected.

**Owner: Carter.** Non-blocking.

---

## 3. Corp-Fork Mergeability

### ✅ Structure is clean for corp branch

A Teams adapter would add:
- `src/channel/teams/index.ts` (new file — implements ChannelPort, calls `registerChannel('teams', ...)`)
- `src/channel/teams/graphClient.ts` (new file — Graph API HTTP client)
- `.env` additions (`TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`, etc.)
- `import './channel/teams/index.js'` in `main.ts` (one line)

No shared files need modification beyond that one import line. No new LOCKSTEP hazards.

### ✅ `main.ts` casting concern

`main.ts` line 64 does `const telegramChannel = channel as TelegramChannel` and accesses `telegramChannel.bot` for AFK mode wiring. When `REACH_CHANNEL=teams`, this cast would fail at runtime. But the AfkModeController is only created when `bridge` is non-null, and the AFK features are Telegram-specific. The corp fork should guard this with `if (cfg.reachChannel === 'telegram')` or move it into the TelegramChannel adapter. This is a known Phase 2 concern, not a Phase 1 blocker.

---

## 4. Correctness / Bugs

### ✅ coerceId migration — Correct

`coerceId(raw)` in `registry.ts` handles both `string` passthrough and `number → String()` conversion. Legacy JSON files with `{ "topicId": 42, "chatId": -100 }` upgrade transparently. The canonical key is `entry.threadId` (string). Legacy numeric keys (`"42"` from `Object.entries`) match via the `String(Number(key)) === key` check. Well-handled.

### ✅ IdleMonitor — Clean migration

`IdleMonitor` now uses `string` keys instead of `number`. All timer operations (`reset`, `cancel`, `cancelAll`) work correctly with string keys.

### ✅ Empty threadId handling — Correct

`TelegramChannel.sendMessage` omits `message_thread_id` when `ctx.threadId` is empty (General Topic). Pinned by Jun's regression test.

### ✅ promptUser AbortSignal — Correct

`TelegramChannel.promptUser` delegates to `promptUserForPermission` which already handles AbortSignal. FakeChannel's text-fallback path correctly resolves `''` on abort. Both pre-aborted and mid-wait abort are tested.

### ✅ `bot.catch` in handlers.ts — Minor duplication

`handlers.ts` line 367 still has `bot.catch(...)`. This is redundant with `TelegramChannel.start()` which also wires `bot.catch()` in line 93. But grammY's `bot.catch` is idempotent (last one wins), so this is harmless. Could clean up in Phase 2.

---

## 5. Conformance Kit Quality

### ✅ Genuinely behavioral

The conformance kit (`tests/channel/conformance/runner.ts`) is behavioral, not just type-shape:

- **Outbound:** Asserts `sendMessage` returns a `MessageRef` with non-empty `id`; asserts empty threadId doesn't throw.
- **Edit:** Asserts `editMessage` returns `false` when `supportsMessageEdit=false` and records no edit; returns `true` when supported.
- **Formatting:** Asserts `formatForTransport` returns non-null string; `splitMessage` enforces `maxMessageLength` on every chunk; footer appears in last chunk.
- **Inbound:** Asserts handler fires with string threadId/channelId; replacement semantics on second `onMessage` call.
- **Prompts:** Asserts text-fallback resolves on matching inbound text; AbortSignal resolves `''`.
- **Threads:** Asserts `createThread` throws when `supportsThreadCreation=false`; returns valid `ChannelContext` when supported.
- **Full matrix:** All 4 capabilities in ON/OFF states, including the "all OFF" scenario (most constrained transport).

### ✅ Plug-in path for future adapters is real

`runChannelPortConformance(makePort, opts)` is parameterized. A Teams conformance test is a 4-line file:
```typescript
import { runChannelPortConformance } from './runner.js';
import { TeamsChannel } from '../../../src/channel/teams/index.js';
runChannelPortConformance(() => new TeamsChannel(mockGraphClient), { name: 'TeamsChannel', skipLifecycle: true });
```

Jun's handoff doc (jun-phase1-conformance.md) documents this exact path with a full example.

### ⚠️ GAP: Conformance kit does not test the relay's capability-check behavior

The conformance kit tests the **adapter's** behavior. It does NOT test the **relay's** response to capabilities (e.g., "when `supportsStreaming=false`, the relay doesn't call `editMessage` during streaming"). This is the same gap identified in F1 above. The relay tests in `tests/relay/relay.test.ts` should gain capability-driven test cases.

**Owner: Jun** (tests) + **Carter** (relay fix). Blocked on F1 fix.

---

## Itemized Findings

| # | Type | Description | Status | Owner |
|---|------|-------------|--------|-------|
| F1 | BUG | Relay does not check `supportsStreaming` / `supportsMessageEdit` before calling `editMessage` during streaming. Violates port contract. Sends useless placeholder + edits for `supportsStreaming:false` adapters. | **RESOLVED** (e1f3f4d + 2b5e4a2, verified commit 2b5e4a2) | Carter + Jun |
| N1 | NIT | `setMessageInterceptor` on TelegramChannel — Telegram-only method off the port. Acceptable Phase-1 debt. | Deferred to Phase 3 (AFK generalization) | Backlog |
| N2 | NIT | Synthetic grammY Context for `/status` and `/cwd`. Compatibility shim — works but not clean. | **RESOLVED** (1754d7f) | Kat |
| N3 | NIT | `asTelegramChannel()` duck-typing in relay for MarkdownV2. Documented, transparent, works. | Deferred to backlog (self-resolves when second adapter ships) | Backlog |
| N4 | NIT | CJS `require('grammy')` in ESM factory registration. Works but code smell. | **RESOLVED** (72fb91e) | Carter |
| N5 | NIT | `bot.catch()` in handlers.ts duplicated with TelegramChannel.start(). Harmless. | **RESOLVED** (1754d7f) | Kat |

**Phase 1 Status:** Reviewer nits N2/N4/N5 resolved (commits 72fb91e, 1754d7f); N1/N3 remain backlog. Phase 1 ship-ready, 946 tests green.

---

## N2 + N5 Cleanup — Resolution Confirmation

**Date:** 2026-06-06  
**Author:** Kat  
**Commit:** 1754d7f (feature/channel-abstraction)  
**Status:** Both nits fully resolved. No port-surface gaps found.

### N2 — Synthetic grammY Context shim removed

Both `/status` and `/cwd` now go through the ChannelPort exclusively.

**Port surface check:** `channel.sendMessage(channelCtx, text)` was sufficient for all reply paths in both handlers. No new port methods were needed.

**`/status`:**
- `HandlerOptions.statusProvider` interface changed: `handleStatusCommand(ctx: Context)` → `handleStatusCommand(channelCtx: ChannelContext)`
- `AfkModeController.handleStatusCommand` refactored to read `channelCtx.threadId !== ''` for topic detection and use `this.safeSendMessage(text, topicId)` for all topic replies. The one no-topic error path uses `this.bot.api.sendMessage(this.chatId, text)` directly (AfkModeController is Telegram-specific; no abstraction leak).
- `handlers.ts` passes `channelCtx` directly.

**`/cwd`:**
- `cwdCommand.ts` signature changed: `(ctx: Context, options)` → `(channelCtx: ChannelContext, args: string, channel: ChannelPort, options)`
- All `ctx.reply()` calls replaced with `channel.sendMessage(channelCtx, text)`. `ctx.match` parsing replaced with the `args` parameter. Topic detection via `channelCtx.threadId !== ''`.
- `handlers.ts` passes `(channelCtx, args, channel, opts)` directly.

`makeSyntheticCtx` helper deleted from `handlers.ts`.

### N5 — Single `bot.catch()`

Removed the duplicate `bot.catch()` from `handlers.ts`. The canonical handler remains in `TelegramChannel.start()` (same log format: `[bot] Unhandled error: <message> <error>`). Transport error handling stays with the transport.

### Test impact

- `tests/bot/afkMode.staleExcerpt.test.ts`: `makeStatusCtx` updated to return `ChannelContext`; `as never` casts removed.
- `tests/channel/conformance/telegram.conformance.test.ts`: Synthetic-ctx describe block replaced with 3 equivalent N2 routing assertions.
- **Total: 946 passing (unchanged).**

## Is the Port Teams-Ready As Written?

**Yes.** The `ChannelPort` interface is Teams-ready today. A Teams adapter with `{ supportsStreaming: false, supportsThreadCreation: false, supportsMessageEdit: true, supportsInteractivePrompts: true, maxMessageLength: 28000 }` can implement it without contract changes.

The relay now honors the capability flags correctly (F1 resolved in commit e1f3f4d, verified in commit 2b5e4a2).

**After Phase 1:** Corp fork can start implementing `TeamsChannel` against the locked port contract with confidence.
