# Kat Phase 1 Handler Migration Notes

## Decision

Single-Bot consolidation is now in place: `TelegramChannel` owns the only grammY `Bot` instance, and `main.ts` casts the selected channel to `TelegramChannel` when direct grammY access is required for `AfkModeController` and related Telegram-only wiring.

## Handlers Now Routed Through ChannelPort

All 8 handlers now register through the port seam via `channel.onCommand()`:

- `new`
- `list`
- `remove`
- `resume`
- `help`
- `pair`
- `status`
- `cwd`

The catch-all relay path now registers via `channel.onMessage()`.

## Notes for Jun's Conformance Kit

- `/status` and `/cwd` use synthetic grammY `Context` adapters — their internal `ctx.reply(...)` calls map to `channel.sendMessage(channelCtx, text)`.
- `handleStatusCommand` still accepts a grammY `Context`; do not change that signature in conformance coverage.
- `handleTelegramMessage` is intercepted before the port `onMessage` handler via `setMessageInterceptor()` on `TelegramChannel` (Telegram-specific by design).
- Capability fallback paths (edit, streaming, prompt, thread creation) are unchanged; they still live in `relay.ts`.
- The handler registered via `channel.onMessage()` applies the `isBotCommand(text)` filter; the Telegram adapter does **not** apply that filter itself.
- Empty `threadId` in `ChannelContext` means General Topic; `TelegramChannel.sendMessage` must omit `message_thread_id` from the Telegram API call in that case.
