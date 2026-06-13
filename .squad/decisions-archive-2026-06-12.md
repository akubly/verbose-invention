> 📦 Entries archived 2026-06-12 (older planning sections, Phase 1/2 background design material).

## Archived Sections (Planning Background, Pre-Review)


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

