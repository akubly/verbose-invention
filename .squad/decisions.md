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

---

## Persona Review Cycle (Phase 1 — Complete)

**Dates:** 2026-06-06  
**Requested by:** Aaron Kubly  
**Branch:** feature/channel-abstraction  

### Cycle Overview

**Cycle 1 (Initial Review):** Code Panel (Correctness/Skeptic/Craft/Compliance/Architect) reviewed Phase 1 deliverables.
- **Blocking findings:** 3 (R1 paired-config regression, B1 relay duck-typing, B2 main.ts cast)
- **Important findings:** 5 (I1–I5)
- **Minor findings:** 4 (M1–M4)

**Cycle 2 (Remediation Verification):** All three remediation agents (Kat, Carter, Jun) delivered fixes; full panel re-verified.
- **Blocking findings from Cycle 1:** 0 remaining — all 3 resolved
- **Important findings from Cycle 1:** 6 remaining (all verified resolved by Cycle 2)
- **New findings in Cycle 2:** 2 important nits (I1-residual allowed-user gating, N1 formatForTransport docstring) + minors
- **Final status:** 0 blocking, all deferred Phase-2 items documented

### Option A: Aaron's Dispositions (Accepted)

After Cycle 1 findings, Aaron chose **Option A:**
- **Fix:** R1 (regression), B1 (duck-typing), B2 (cast), I1–I3 (conditional creds, boolean, adapter contract), I1 (cheap minors)
- **Defer:** I4 (optional createThread interface), I5 (ChannelMessage union for Adaptive Cards), M5 (central mock factory)

**Remediation agents assigned:**
- **Kat (ad05548):** I3 (remove bot/telegramMirror from HandlerOptions), M1 (/help heading), M3 (topicId guard)
- **Carter (58e1326, 5b6d30c):** R1 (cfg-factory), B1 (relay de-duck-type), B2 (AFK guard), I1 (conditional creds), I2 (boolean return)
- **Jun (823e5d8):** +17 regression tests covering R1, B2, B1, I2; verified all prior findings resolved

### R1 — Real Regression (Previously Missed)

**Finding:** The original Telegram factory read process.env.TELEGRAM_CHAT_ID directly, ignoring the resolved cfg.chatId from config.json.

`	ypescript
// PRE-FIX (WRONG):
registerChannel('telegram', () =>
  new TelegramChannel(
    new Bot(process.env.TELEGRAM_BOT_TOKEN!),
    Number(process.env.TELEGRAM_CHAT_ID) || 0,  // ← ignores cfg.chatId
  )
);

// POST-FIX (CORRECT):
registerChannel('telegram', (cfg) => {
  if (!cfg.token) throw new Error('[telegram] TELEGRAM_BOT_TOKEN is required...');
  return new TelegramChannel(new Bot(cfg.token), cfg.chatId ?? 0);  // ← uses cfg
});
`

**Why missed in Phase 1 review:** The factory signature was updated but the implementation continued reading process.env. Jun's R1a test confirms: with TELEGRAM_CHAT_ID unset and cfg.chatId=99999, the pre-fix factory would have initialized with llowedChatId=0 (wrong), while post-fix returns llowedChatId=99999 (correct).

**Cycle 2 resolution:** Carter's fix (58e1326) + Jun's regression tests (823e5d8) both verified correct.

### Deferred Phase-2 Items

Per Aaron's Option A dispositions, the following items are deferred to Phase 2:

| Item | Description | Owner | Reason |
|------|-------------|-------|--------|
| I4 | Optional createThread interface extension | Backlog | Non-critical for Telegram; needed for async Teams thread creation |
| I5 | ChannelMessage union type for Adaptive Cards | Backlog | Teams formatting; not needed for Telegram MVP |
| M5 | Central mock factory consolidation | Backlog | Test infrastructure improvement; lower priority than fixes |

### Final Metrics

- **Baseline (HEAD=58e1326):** 946 tests green
- **After Jun's regression tests (HEAD=823e5d8):** 963 tests green (+17 new, all passing)
- **Code cleanliness:** tsc + lint clean
- **Review status:** 2-cycle persona review PASSED; 0 blocking, all prior findings verified resolved
- **Ship readiness:** Ready for /ship-to-pr

---

### Remediation Detail

#### Kat — Cycle 1 Fixes (ad05548)

**Items:** I3 (HandlerOptions cleanup), M1 (/help heading), M3 (topicId guard)

- Removed ot: Bot<Context> and 	elegramMirror from HandlerOptions → eliminated redundant imports in handlers.ts
- Updated /help heading from "Reach — Telegram ↔ Copilot CLI bridge" to "Reach — Copilot CLI bridge"
- Added topicId guard in promptUser and sendMessageWithMarkdown (conditional message_thread_id spread)

#### Carter — Cycle 1 + Cycle 2 Fixes (58e1326, 5b6d30c)

**Cycle 1 (58e1326) — Items:** R1 (cfg-factory), B1 (relay de-duck-type), B2 (AFK guard), I1 (creds conditional), I2 (boolean return)

- **R1:** Factory now reads resolved cfg.token and cfg.chatId instead of process.env directly
- **B1:** Relay no longer duck-types TelegramChannel; calls channel.sendMessage/editMessage uniformly across all capability branches
- **B2:** main.ts guards AFK mode setup with channel instanceof TelegramChannel check; non-Telegram channels log warning and boot normally
- **I1:** TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID validated only when REACH_CHANNEL==='telegram'; EnvConfig.token is string | undefined
- **I2:** safeEdit() now returns wait channel.editMessage(...) directly, propagating false-return to "failed to render reply" fallback

**Cycle 2 (5b6d30c) — Items:** I1-residual (allowed-user gating fix), N1 (formatForTransport docstring)

- Fixed I1-residual: allowed-user gating for non-Telegram channels (already verified in Cycle 1 but confirmed in Cycle 2)
- Added formatForTransport docstring clarity (N1)

#### Jun — Cycle 1 Verification (823e5d8)

**Items:** R1, B2, B1, I2 regression tests (+17 total)

- **R1a–R1d:** 4 tests for factory cfg-reading (chatId, token) from resolved EnvConfig vs process.env
- **B2a–B2d:** 4 tests for non-Telegram boot without AfkModeController
- **B1a–B1e:** 5 tests for relay passing raw text, never calling formatForTransport, across all capability branches
- **I2a–I2d:** 4 tests for editMessage false-return propagation to fallback path

**Baseline:** 946 tests  
**After:** 963 tests (+17 new, all passing)  
**Verification:** All cycle-1 findings verified resolved; no new regressions found

---

### Cycle 2 Outcome (Confirmed PASS)

**Cycle 2 persona review panel findings summary:**
- **Blocking findings:** 0 (all 3 from Cycle 1 resolved and verified)
- **Important findings:** 6 (all from Cycle 1 — verified resolved by all personas)
- **Important nits in Cycle 2:** 2 (I1-residual, N1) → both fixed by Carter (5b6d30c)
- **Minor findings:** All addressed in remediation or deferred to Phase 2
- **Test suite:** 963 tests green, tsc+lint clean
- **Final verdict:** PHASE-1 COMPLETE, READY FOR SHIP-TO-PR

---

## Phase 2 — Teams Adapter (Corp-Fork) — Kickoff Plan [APPROVED]

**Status:** APPROVED (Aaron, 2026-06-10)
**Author:** Noble Six (Lead/Architect)
**Date drafted:** 2026-06-10
**Branch base:** main (Phase 1 merged as ddf023c)

### 2.1 Pre-reqs / Corp Environment Checklist

Everything below must exist in the corp tenant before the adapter can authenticate or send messages.

#### 2.1.1 Azure AD App Registration

| Step | Detail |
|------|--------|
| Register app | Azure Portal → App registrations → New registration. Single-tenant (corp tenant only). No redirect URI needed (daemon/client-credentials flow). |
| Authentication | Client-credentials flow (OAuth 2.0 client_credentials grant). No user sign-in; the app acts as itself. |
| Certificate or secret | **Recommended: certificate** for production (longer lifetime, non-extractable). Client secret acceptable for initial development (shorter rotation). |
| Record IDs | Tenant ID (`TEAMS_TENANT_ID`), Application/Client ID (`TEAMS_CLIENT_ID`). |

#### 2.1.2 Microsoft Graph API Permissions (Application)

All permissions are **Application** type (not Delegated), requiring **admin consent**.

| Permission | Type | Justification |
|------------|------|---------------|
| `ChannelMessage.Read.All` | Application | Poll inbound messages from the target Teams channel. |
| `ChannelMessage.Send` | Application | Send outbound messages (bot responses) to the channel. |
| `Chat.ReadWrite.All` | Application | Required if targeting 1:1 or group chats instead of/in addition to team channels. Can be omitted if only targeting team channels. |
| `ChannelMessage.ReadWrite.All` | Application | Required for editing sent messages (PATCH). Superset of Send+Read. **Use this instead of the two individual Read/Send permissions if supportsMessageEdit=true.** |

#### 2.1.3 Admin Consent

One-time admin consent required for application permissions via Azure Portal → Enterprise applications → Permissions → Grant admin consent.

#### 2.1.4 Secret/Certificate Storage

- **Secrets MUST NOT be in the repo** (not in `.env`, not in config.json, not in source).
- Corp environment options (Aaron to confirm which):
  - Azure Key Vault (preferred — auto-rotation, audit trail)
  - Environment variables set by the corp deployment pipeline
  - Local `.env.local` file excluded via `.gitignore` (development only)
- The adapter reads credentials from `EnvConfig` (resolved at startup by `parseEnv()`), never from `process.env` directly.

#### 2.1.5 Test Team/Channel

| Item | Detail |
|------|--------|
| Target Team | A dedicated test Team (or existing team with a test channel). |
| Target Channel | A specific channel within the team for Reach messages. |
| Record IDs | Team ID (`TEAMS_TEAM_ID`), Channel ID (`TEAMS_CHANNEL_ID`). Both are GUIDs from Graph. |
| Verification | Post a test message via Graph Explorer to confirm permissions work before writing adapter code. |

### 2.2 TeamsChannel Adapter Design

#### 2.2.1 Module Structure

```
src/channel/teams/
├── index.ts          # TeamsChannel class + registerChannel('teams', factory)
├── graphClient.ts    # Graph REST HTTP client (auth, send, edit, poll)
├── formatting.ts     # HTML/Adaptive Card formatting helpers
└── types.ts          # Teams-specific types (GraphMessage, etc.)
```

#### 2.2.2 ChannelPort Method-by-Method Implementation

| Method | Teams Implementation |
|--------|---------------------|
| `name` | `'teams'` |
| `capabilities` | See §2.3 |
| `start()` | Acquire OAuth token (client-credentials), validate permissions with a test Graph call, start the polling loop. |
| `stop()` | Stop the polling loop, cancel any pending token refresh timers. |
| `sendMessage(ctx, text)` | `POST /teams/{teamId}/channels/{channelId}/messages` with `body.content = formatForTransport(text)`, `body.contentType = 'html'`. Returns `MessageRef { id: graphMessageId }`. |
| `editMessage(ctx, ref, text)` | `PATCH /teams/{teamId}/channels/{channelId}/messages/{messageId}` with updated `body.content`. Returns `true` on success, `false` on 429/failure. |
| `formatForTransport(markdown)` | Convert raw markdown to Teams-compatible HTML. Teams supports a subset of HTML (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`, `<br>`, lists). |
| `splitMessage(text, footer?)` | Split at `maxMessageLength` (28,000 chars for Graph messages). Simple character-boundary split with paragraph-break preference. |
| `promptUser(ctx, question, options, signal?)` | `supportsInteractivePrompts=false` for v1 → **text-fallback path**: post the question + numbered options as a plain-text message, then wait for a matching inbound reply. Resolve on match or `''` on abort signal. |
| `createThread(channelId, title)` | Method **omitted** — `supportsThreadCreation=false`; TeamsChannel does not implement `createThread` (it is optional in ChannelPort). Core MUST NOT call this method. |
| `onMessage(handler)` | Stores the handler. The polling loop dispatches to it. |
| `onCommand(command, handler)` | Stores the handler. The polling loop parses `/command args` prefix from inbound messages and dispatches. |

#### 2.2.3 Capabilities Descriptor

```typescript
readonly capabilities: ChannelCapabilities = {
  supportsMessageEdit: false,      // ← See locked decision below
  supportsThreadCreation: false,
  supportsInteractivePrompts: false, // text-fallback; Adaptive Cards in v2
  supportsStreaming: false,
  maxMessageLength: 28_000,
};
```

#### 2.2.4 Formatting: HTML for v1, Adaptive Cards Deferred

**v1 approach:** `formatForTransport()` converts raw markdown to Teams HTML subset:
- `**bold**` → `<b>bold</b>`
- `` `code` `` → `<code>code</code>`
- Code fences → `<pre>code</pre>`
- Links → `<a href="...">text</a>`
- Line breaks → `<br>`
- Lists → `<ul><li>` / `<ol><li>`

Full Adaptive Card formatting is Phase 3 scope.

#### 2.2.5 promptUser Text-Fallback Flow

1. Post a message: `"🔐 Permission required: {question}\n\n1️⃣ {options[0].label}\n2️⃣ {options[1].label}\n\nReply with the number or value to choose."`
2. Register a one-shot interceptor on the polling loop that watches for a reply matching an option value (or number).
3. On match → resolve the promise with the matched option's `value`.
4. On AbortSignal → resolve with `''`.
5. Timeout (configurable, default 5 minutes) → resolve with `''` (same as abort).

#### 2.2.6 Teams Concept Mapping

| ChannelPort Concept | Teams Concept | Type |
|---------------------|---------------|------|
| `channelId` | Teams Channel ID (GUID) | Opaque string |
| `threadId` | Reply chain root message ID (or `''` for top-level) | Opaque string |
| `MessageRef.id` | Graph message ID | Opaque string |

### 2.3 Inbound Polling Design

#### 2.3.1 Polling Mechanism

**Option A: Delta query** — `GET /teams/{teamId}/channels/{channelId}/messages/delta`
- Returns only new/changed messages since last delta token (preferred).

**Option B: List with filter** — `GET /teams/{teamId}/channels/{channelId}/messages?$top=25&$orderby=createdDateTime desc`
- Requires client-side de-duplication (simpler but higher bandwidth).

**Recommendation: Option A (delta query).** Falls back to Option B if delta is unavailable.

#### 2.3.2 Poll Interval & Rate Budget

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Poll interval | **3 seconds** | Balances responsiveness (~3s input latency) against rate limits. |
| Rate budget (polling) | ~0.33 req/sec (1 request per 3s) | Leaves ~1.67 req/sec for outbound (send, token refresh). |
| Rate budget (outbound) | ~1.5 req/sec | Sufficient for typical Reach response patterns (1–3 messages per interaction). |
| Backoff on 429 | Exponential: 5s → 10s → 20s → 60s cap | Honor `Retry-After` header when present. |
| Backoff on 5xx | Same exponential, reset on success. | |

#### 2.3.3 De-duplication & Cursor Persistence

- **Delta token** persisted to the same config directory as the session registry (`getReachDataDir()`). File: `teams-delta-token.json`.
- On startup, if a persisted delta token exists, resume from it. If not (first run or token expired), do a full sync and discard historical messages.
- **Edge case:** Delta tokens expire after ~30 days. If expired, fall back to full sync with timestamp filter.

#### 2.3.4 Polling Loop → Handler Dispatch

```
poll() → parse messages → for each new message:
  1. Extract text content from message body (strip HTML tags)
  2. If text starts with '/command' → parse command name + args → dispatch to onCommand handler
  3. Otherwise → dispatch to onMessage handler
  4. Build ChannelContext: { channelId: teams channel ID, threadId: reply chain root ID or '' }
```

- The polling loop runs on a `setInterval` / recursive `setTimeout` with drift correction.
- Errors in the polling loop are logged and retried; they do not crash the daemon.
- The polling loop shares a rate-limiter with outbound calls (single token bucket for the app's Graph quota).

### 2.4 Config & Selection

#### 2.4.1 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REACH_CHANNEL=teams` | Yes | Selects the Teams transport. |
| `TEAMS_TENANT_ID` | Yes | Azure AD tenant ID (GUID). |
| `TEAMS_CLIENT_ID` | Yes | App registration client ID (GUID). |
| `TEAMS_CLIENT_SECRET` | Yes | Client secret for client-credentials OAuth2 auth. Phase 2a requires this. |
| `TEAMS_CLIENT_CERT_PATH` | — | **Phase 2b / future** (NOT implemented in open repo). Cert-based client-credentials auth. Phase 2a uses `TEAMS_CLIENT_SECRET` only. |
| `TEAMS_TEAM_ID` | Yes | Target Team ID (GUID). |
| `TEAMS_CHANNEL_ID` | Yes | Target Channel ID within the Team (GUID). |

#### 2.4.2 EnvConfig Extension

```typescript
export interface EnvConfig {
  // ... existing fields ...

  // Teams-specific (defined when reachChannel === 'teams'; undefined otherwise)
  teamsTenantId: string | undefined;
  teamsClientId: string | undefined;
  teamsClientSecret: string | undefined;        // Phase 2a: client-secret auth only
  // teamsClientCertPath: string | undefined;   // Phase 2b / future: cert-based auth (not in open repo)
  teamsTeamId: string | undefined;
  teamsChannelId: string | undefined;
}
```

#### 2.4.3 Factory Registration

```typescript
registerChannel('teams', (cfg) => {
  if (!cfg.teamsTenantId || !cfg.teamsClientId || !cfg.teamsClientSecret) {
    throw new Error(
      '[teams] TEAMS_TENANT_ID, TEAMS_CLIENT_ID, and TEAMS_CLIENT_SECRET are required ' +
      'when REACH_CHANNEL=teams',
    );
  }
  if (!cfg.teamsTeamId || !cfg.teamsChannelId) {
    throw new Error(
      '[teams] TEAMS_TEAM_ID and TEAMS_CHANNEL_ID are required when REACH_CHANNEL=teams',
    );
  }
  return new TeamsChannel();
});
```

### 2.5 Corp-Fork Branching / Sync Strategy

#### 2.5.1 Branch Model

```
main (open repo)
  │
  ├── feature/teams-contract    ← I4/I5 contract refactors (open, PR'd to main)
  │
  └── corp/teams-adapter        ← Corp fork branch
        ├── rebases on main
        ├── Adds: src/channel/teams/ (full adapter)
        ├── Adds: Teams env config in src/config/env.ts
        ├── Adds: import './channel/teams/index.js' in main.ts
        └── Adds: .env.local.example (with placeholder TEAMS_* vars)
```

#### 2.5.2 What Lives Where

| Component | Open Repo | Corp Fork |
|-----------|-----------|-----------|
| ChannelPort contract (port.ts) | ✅ Source of truth | Inherited via rebase |
| I4/I5 contract changes | ✅ PR'd to main first | Inherited via rebase |
| Transport registry | ✅ Source of truth | Inherited |
| Conformance kit | ✅ Source of truth | Inherited + Teams conformance test added |
| TeamsChannel adapter stub | ✅ (optional — can land as a types-only stub) | Full implementation |
| TeamsChannel live implementation | ❌ | ✅ (graphClient, polling, formatting) |
| Teams env config validation | ✅ (parseEnv Teams block) | Inherited |
| Secrets / tenant config | ❌ Never | ✅ (.env.local, Key Vault) |
| Integration tests (live Graph) | ❌ | ✅ Corp-only test suite |

#### 2.5.3 Keeping the Diff Minimal

- Corp branch diffs from main should be **only**:
  1. `src/channel/teams/` directory (new files)
  2. `src/config/env.ts` — Teams credential block (additive, no Telegram changes)
  3. `src/main.ts` — one import line + one `if (cfg.reachChannel === 'teams')` guard
  4. `tests/channel/conformance/teams.conformance.test.ts` (new file)
  5. `.env.local.example` (new file)
- No modifications to existing Telegram code, relay, session management, or core logic.

### 2.6 How I4 & I5 Fold In

#### 2.6.1 I4: Optional createThread Interface

**Current state:** `createThread()` is a required method on ChannelPort. When `supportsThreadCreation=false`, the adapter must still implement the method (throwing an error).

**Desired state:** Make `createThread` truly optional (discriminated union or conditional interface).

**Recommendation: Refactor FIRST (in the open repo, before Teams adapter).**

Reasoning:
- The Teams adapter will have `supportsThreadCreation=false`. Under the current contract, it must implement a throwing `createThread()` — boilerplate that the I4 refactor eliminates.
- Doing it in the open repo first means the conformance kit is updated once, and both Telegram and Teams adapters benefit.
- Doing it opportunistically during Phase 2 risks the corp branch diverging from main on the contract file, creating rebase conflicts.

**Scope:** Small refactor — ~50 lines in port.ts, ~20 lines in runner.ts, ~10 lines in TelegramChannel. Can be a single PR.

#### 2.6.2 I5: ChannelMessage Union for Adaptive Cards

**Current state:** `sendMessage()` and `editMessage()` accept `text: string`. There's no way to pass structured content (Adaptive Card JSON) through the port.

**Recommendation: DEFER (do NOT refactor first).**

Reasoning:
- The Teams v1 adapter uses HTML formatting via `formatForTransport()` — it doesn't need Adaptive Cards yet.
- The `ChannelMessage` union design depends on understanding what structured payloads Teams/Slack/Discord actually need. Designing it in the abstract risks over-engineering.
- When Adaptive Cards become a real requirement (Phase 3), we'll have concrete use cases to drive the design.

### 2.7 Phased Work Items with Owners

#### 2.7.1 Phase 2a — Open Repo (no corp access required)

| ID | Item | Owner | Description | Blocked? |
|----|------|-------|-------------|----------|
| P2a-1 | I4 contract refactor | Noble Six | Make `createThread` optional on ChannelPort. Update conformance kit. PR to main. | No |
| P2a-2 | Teams env config | Carter | Add `TEAMS_*` validation block to `parseEnv()`, extend `EnvConfig` interface. Conditional on `reachChannel === 'teams'`. | No |
| P2a-3 | Teams adapter stub | Carter | `src/channel/teams/index.ts` with `TeamsChannel` class, all methods stubbed (throw "not configured for live Graph"), capabilities declared. Passes conformance kit with `skipLifecycle: true`. `registerChannel('teams', factory)`. | Depends on P2a-1 |
| P2a-4 | HTML formatting module | Kat | `src/channel/teams/formatting.ts` — markdown-to-HTML converter for Teams HTML subset. Unit-testable in open repo, no Graph dependency. | No |
| P2a-5 | Text-prompt fallback design | Kat | Implement `promptUser` text-fallback in the adapter stub. Testable against FakeChannel pattern. | No |
| P2a-6 | Conformance wiring | Jun | `tests/channel/conformance/teams.conformance.test.ts` — run conformance kit against TeamsChannel stub with mock Graph client. | Depends on P2a-3 |

#### 2.7.2 Phase 2b — Corp Fork (requires corp access)

| ID | Item | Owner | Description | Blocked? |
|----|------|-------|-------------|----------|
| P2b-1 | Azure AD app registration | Corp-side | Register app, configure permissions, admin consent. Record tenant/client IDs. | **Corp access** |
| P2b-2 | Graph REST client | Carter | `src/channel/teams/graphClient.ts` — OAuth token acquisition (client-credentials), send, edit (if enabled), poll. Rate-limit-aware with shared token bucket. | **Corp access** (for live testing) |
| P2b-3 | Polling loop | Carter | Delta query polling, cursor persistence, dispatch to onMessage/onCommand. Backoff on 429/5xx. | **Corp access** |
| P2b-4 | Live adapter wiring | Carter | Connect graphClient to TeamsChannel methods. Replace stubs with real Graph calls. | Depends on P2b-1, P2b-2, P2b-3 |
| P2b-5 | Teams formatting validation | Kat | Test HTML formatting in live Teams channel. Iterate on edge cases (code blocks, long messages, unicode). | **Corp access** |
| P2b-6 | Integration testing | Jun | Run conformance kit against live TeamsChannel in corp. Validate polling latency, rate limits, message round-trip. | **Corp access**, depends on P2b-4 |
| P2b-7 | Streaming UX validation | Noble Six | Confirm S1 (single final message, no edits) is acceptable UX. Measure actual latency. Document whether S2 (edit-based) is worth pursuing. | **Corp access** |
| P2b-8 | ADR update | Noble Six | Update decisions.md with Phase 2 outcomes, lock capability decisions, document rate-limit findings. | After P2b-6/P2b-7 |

### 2.8 Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Graph rate limits are tighter than documented | Medium | Polling becomes unreliable; outbound messages fail | Start with conservative 3s interval; implement adaptive backoff; monitor 429 response rates |
| Delta query not available for channel messages with application permissions | Low | Must fall back to list+filter (Option B), higher bandwidth | Validate in corp before building the polling loop |
| Admin consent blocked by corp IT policy | Low | Cannot proceed at all | Escalate early; have the app registration request ready before coding starts |
| Corp branch diverges too far from main | Medium | Rebase pain | Keep diff minimal; land I4/env config in open repo first; frequent rebases |
| Teams HTML rendering differs from documentation | Medium | Formatting looks wrong | Kat validates formatting in live Teams early (P2b-5); iterate |

---

## Phase 2 Locked Decisions (Aaron, 2026-06-10)

Per Aaron's approval of the Phase 2 Kickoff Plan, the following decisions are LOCKED and supersede any conflicting recommendations:

### OD-1: supportsMessageEdit = FALSE (v1)

**Decision:** `supportsMessageEdit: false` for Teams adapter v1.

**Rationale:** Rate-limit risk outweighs UX benefit when streaming is already disabled. With 3-second polling consuming ~0.33 req/sec, adding edits would consume additional budget. Graph API rate limits are ~2 req/sec shared across all operations. Revisit in Phase 3 with production rate-limit data.

**Implication:** 
- Require only `ChannelMessage.Read.All` + `ChannelMessage.Send` Graph permissions (narrower scope than `ChannelMessage.ReadWrite.All`).
- Relay never calls `editMessage()` on Teams adapter (capability flag gates all calls).
- HUD footer updates unavailable in v1; revisit if rate budget allows in Phase 3.

### OD-2: Poll Interval = 3 Seconds

**Decision:** Use 3-second polling interval as the default.

**Rationale:** Balances UX responsiveness (~3s input latency) against rate-limit headroom. 1–2s risks throttling; 5–10s feels sluggish. Implement exponential backoff (5s → 10s → 20s → 60s) on 429/5xx errors.

### OD-3: I4 Refactor First (in open repo)

**Decision:** Refactor `createThread()` to optional in the open repo BEFORE the corp fork branches off.

**Rationale:** Small PR (~80 lines total). Prevents the Teams adapter from implementing a boilerplate throwing method. Keeps both Telegram and Teams adapters clean. Doing it in the open repo first avoids rebase conflicts when the corp branch inherits the updated ChannelPort contract.

**Implication:** P2a-1 (I4 refactor) is the first work item in Phase 2a; P2a-3 (Teams adapter stub) depends on it.

### OD-4: I5 Deferred to Phase 3

**Decision:** DEFER the `ChannelMessage` union (I5) to Phase 3. Do not refactor in Phase 2.

**Rationale:** Teams v1 uses HTML formatting via `formatForTransport()` — no need for structured payloads yet. Designing a `ChannelMessage` union in the abstract risks over-engineering. Adaptive Cards require concrete use cases (interactive prompts, rich formatting) that we don't have yet. Revisit in Phase 3 when Teams interactive features are in scope.

---

*Phase 2 plan is ready for execution. Phase 2a (open repo) kicks off next session with work items P2a-1 through P2a-6. Phase 2b (corp fork) begins after P2b-1 (Azure AD app registration) is complete.*

---

## Phase 2a Execution Summary (2026-06-10)

**Status:** COMPLETE  
**Branch:** `user/aaron/phase2a`  
**Commits:** 71054e7 (Noble Six), 1b4862a (Carter), ca7a0ea + 3c4f25b (Kat), 8192f50 (Jun)  
**Test result:** 1139 tests pass, tsc clean, lint clean

### Noble Six — P2a-1: I4 Optional `createThread` Refactor (71054e7)

`createThread` is now an **optional method** on `ChannelPort`:
```typescript
createThread?(channelId: string, title: string): Promise<ChannelContext>;
```

**Semantics:**
- `supportsThreadCreation=true` → method MUST be present and functional
- `supportsThreadCreation=false` → method MAY be absent; absence is correct

**Caller guard (ALL callers MUST use):**
```typescript
if (!channel.capabilities.supportsThreadCreation || !channel.createThread) {
  throw new Error(`[caller] createThread not supported by ${channel.name}`);
}
const ctx = await channel.createThread(channelId, title);
```

**Conformance kit updated:** `supportsThreadCreation=true` asserts method presence; `false` path does NOT call the method.

**Files changed:** `src/channel/port.ts` (optional method + TSDoc), `tests/channel/conformance/runner.ts` (updated section 6). No caller changes needed — AFK mode uses `bot.api.createForumTopic()` directly.

---

### Carter — P2a-2: Teams Environment Variables (1b4862a)

Five required env vars when `REACH_CHANNEL=teams`:

| Env var | EnvConfig field | Graph context |
|---------|-----------------|---------------|
| `TEAMS_TENANT_ID` | `teamsTenantId` | Azure AD directory ID |
| `TEAMS_CLIENT_ID` | `teamsClientId` | Azure AD application ID |
| `TEAMS_CLIENT_SECRET` | `teamsClientSecret` | Azure AD client secret |
| `TEAMS_TEAM_ID` | `teamsTeamId` | Teams team GUID |
| `TEAMS_CHANNEL_ID` | `teamsChannelId` | Channel ID within team |

**Validation:** Conditional on `reachChannel === 'teams'`; fail-fast with `[reach] Fatal:` prefix.

---

### Carter — P2a-3: TeamsChannel Stub (1b4862a)

TeamsChannel satisfies `ChannelPort` with:
- **Capabilities:** `supportsMessageEdit=false`, `supportsThreadCreation=false`, `supportsInteractivePrompts=false`, `supportsStreaming=false`, `maxMessageLength=28000`
- **NO `createThread` method** — per I4 contract, absence is correct
- **Self-registration:** `registerChannel('teams', factory)` in module scope
- **Conformance:** Passes kit with `skipLifecycle=true`
- **Methods:** All stubbed; throws `[teams] not configured for live Graph` on `start()`

**Text-fallback `promptUser`:** Uses numbered options format; matches by 1-based index or case-insensitive value. Invalid replies silently ignored while prompt pending.

---

### Kat — P2a-4: Teams HTML Formatting (ca7a0ea)

Module: `src/channel/teams/formatting.ts` → `formatForTransport(markdown: string): string`

**HTML subset emitted:**
- `<b>`, `<i>` (bold, italic)
- `<code>`, `<pre><code>` (inline, fenced)
- `<a href="...">` (links)
- `<br>` (linebreaks)
- `<ul>/<li>`, `<ol>/<li>` (lists)

**Not emitted:** Adaptive Cards (Phase 2b), `class=` attributes, heading levels.

**Escaping:** `escapeHtml` for body (safe entities), `escapeHtmlAttr` for `href` values.

**59 tests pass** covering all tag types, edge cases, nested formatting, and escaping.

---

### Kat — P2a-5: `promptUser` Text-Fallback Fixes (3c4f25b)

Refined text-fallback contract for `TeamsChannel.promptUser`:

| Gap in stub | Fix |
|-------------|-----|
| No indication of what to type | Render options with "Reply with option number or name" |
| Case-sensitive exact match only | Match by 1-based index OR case-insensitive value |
| Unmatched text routed to `messageHandler` | Silently ignore non-matching replies while prompt pending |
| `options=[]` hangs forever | Return `''` immediately on empty options |

**Edge cases handled:** Pre-aborted signal, mid-wait abort, empty options, stray text.

**26 tests pass** covering all cases.

---

### Jun — P2a-6: Teams Conformance Test Suite (8192f50)

New file: `tests/channel/conformance/teams.conformance.test.ts`

**52 tests:**
- Mandatory tests (send, split, format, capabilities) — all pass
- Optional capability tests (thread creation, streaming, edits, prompts) — correctly skipped per flags
- Adapter contract enforcement — no defects

**Result:** All 52 pass; Teams adapter validated against port contract.

---

### Health Metrics

- **Commits:** 5 (one per agent + Noble Six lead)
- **Test suite:** 1139 tests pass (baseline 1091 + 48 new)
  - Kat: 59 (formatting) + 26 (promptUser) = 85
  - Jun: 52 (conformance) = 52
  - Net: 137 new; baseline regression = none
- **Code cleanliness:** `tsc` clean, `npm run lint` clean
- **Dependencies:** No new packages
- **Branch readiness:** Squash-merge candidate to `main`

