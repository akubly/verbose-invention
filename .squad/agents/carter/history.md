# Carter — History (Phase 1 Complete 2026-06-06, commit d84dc0c; Persona Review Cycle 2 PASSED 2026-06-07)

---

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