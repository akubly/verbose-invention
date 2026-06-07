# Kat — History (Phase 1 Complete 2026-06-06, commit e69e50b; Persona Review Cycle 2 PASSED 2026-06-07)

---

**PHASE 1 COMPLETE + PERSONA REVIEW CYCLE PASSED (2026-06-07):** Shipped handler migration onto ChannelPort. Single-bot consolidation complete; TelegramChannel owns only grammY Bot instance. All 8 commands registered via channel.onCommand(); relay catch-all via channel.onMessage(). Synthetic context adapters for /status and /cwd maintain handler API compatibility. F1 blocker (relay capability branching) resolved by Carter + verified by Jun. **Two-cycle persona review completed:**
- **Cycle 1 findings:** 3 blocking, 5 important, 4 minor
- **Kat fixes:** I3 (HandlerOptions cleanup), M1 (/help heading), M3 (topicId guard) delivered ad05548
- **Cycle 2 outcome:** 0 blocking, all 6 prior important findings verified resolved by all Code Panel personas
- **Final test count:** 963 green (+17 from Jun's regression tests, all passing)
- **Ship status:** READY FOR /ship-to-pr
- **Deferred to Phase 2:** I4 (optional createThread), I5 (ChannelMessage union), M5 (central mock factory)

Reference: Phase 1 section in decisions.md; orchestration log at .squad/orchestration-log/2026-06-07-persona-review-phase1.md. Next: Teams Phase 2 pending corp access.

---

## Learnings

### N2 — /status and /cwd now use the port directly (2026-06-06, commit 1754d7f)

Both commands previously built a synthetic grammY `Context` shim to call legacy APIs. After N2:

- **`/status`**: `handlers.ts` calls `statusProvider.handleStatusCommand(channelCtx)` directly. The `statusProvider` interface in `HandlerOptions` was changed from `handleStatusCommand(ctx: Context)` to `handleStatusCommand(channelCtx: ChannelContext)`. `AfkModeController.handleStatusCommand` now reads `channelCtx.threadId` for topic detection and routes all replies through `this.safeSendMessage(text, topicId)` (or `bot.api.sendMessage` for the no-topic error case).

- **`/cwd`**: `handlers.ts` calls `handleCwdCommand(channelCtx, args, channel, opts)` directly. `cwdCommand.ts` was refactored to accept `(channelCtx: ChannelContext, args: string, channel: ChannelPort, options)` — no grammY imports remain. Topic detection uses `channelCtx.threadId !== ''`. All replies go through `channel.sendMessage(channelCtx, text)`.

The `makeSyntheticCtx` helper in `handlers.ts` was deleted entirely.

### N5 — Exactly one `bot.catch()` lives in `TelegramChannel.start()` (2026-06-06, commit 1754d7f)

The duplicate `bot.catch()` in `handlers.ts` was removed. The single canonical error handler is in `src/channel/telegram/index.ts` `start()` — transport-owned error handling belongs with the transport. Same log format: `[bot] Unhandled error: <message> <error>`.

---

### B1-adapter / I3 / M1 / M3 — Review cycle 1 adapter fixes (2026-06-06)

**B1 (adapter side):** `TelegramChannel.sendMessage` and `editMessage` are now fully self-sufficient. Both delegate to private helpers `_sendMessageInternal` / `_editMessageInternal` that apply `escapeMarkdownV2` and send with `parse_mode: 'MarkdownV2'`, falling back to plain text on parse-entities errors (same `md2WarnedSessions` dedup logic, same warn format). `sendMessageWithMarkdown` and `editMessageWithMarkdown` are now thin wrappers that call the internal helpers and handle the return-type difference (null vs throw). **Carter's relay change must pass RAW text** to `sendMessage`/`editMessage` — pre-formatting via `formatForTransport` before calling these will double-escape.

**I3:** Removed `bot: Bot<Context>` and `telegramMirror` from `HandlerOptions`. `ensurePromptRegistry` is now exclusively owned by `TelegramChannel.start()`. `registerHandlers` no longer imports `Bot`/`Context` from grammy or `ensurePromptRegistry` from prompt. Main.ts minimal edit: removed `bot` and `telegramMirror` from the options object only. Three tests in the "eager callback_query:data" describe block were rewritten to test the relay-level permission behavior (factory gets callback arg when `permissionPolicy=interactiveDestructive`) instead of the removed bot-level behavior.

**M1:** `/help` heading changed from "Reach — Telegram ↔ Copilot CLI bridge" to "Reach — Copilot CLI bridge".

**M3:** `promptUser` now derives `topicId` conditionally (`ctx.threadId ? Number(...) : undefined`), matching the guard in `sendMessage`. `promptUserForPermission` in `prompt.ts` updated to accept `topicId: number | undefined` and conditionally includes `message_thread_id` in the send options. `sendMessageWithMarkdown` uses `_sendMessageInternal` which already has the guard.

---