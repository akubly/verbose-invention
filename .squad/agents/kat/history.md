# Kat — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Bot Dev
- **Joined:** 2026-04-12T06:02:10.441Z

## Project Background

Reach is Aaron's personal mobile bridge for Copilot CLI. Telegram forum topics are the UI — one topic = one named Copilot session. I'm Kat, Bot Dev. I own the grammY bot wiring, UX of commands, and Telegram-side message formatting. Carter owns the relay/bridge internals; I own the user-facing bot surface.

## What's Been Built (Day 1)

The initial bot scaffold is in place:
- **`src/bot/index.ts`** — `createBot()` factory; optional chatId guard middleware
- **`src/bot/handlers.ts`** — `/new <name>`, `/list`, `/remove`, catch-all relay; minimal but functional

## UX Gaps to Address

The Day 1 bot is functional but Spartan (pun intended). Key UX improvements to consider:

1. **`/resume <name>`** — re-link an existing named session to a new topic (e.g. if topic was accidentally deleted). Currently a user would have to delete registry entry and `/new` again.
2. **HUD footer** (inspired by `julianchun/copilot-telegram-bot`) — append a compact status footer to bot replies: `repo: cairn | branch: main | model: claude-sonnet-4.5`. Needs Noble Six's SDK binding to expose these fields.
3. **Two-tier permissions** (inspired by `julianchun/copilot-telegram-bot`) — auto-approve "safe" tool uses; prompt for destructive ones. Stretch goal.
4. **Session export to Markdown** — `/export` command to download the session transcript. Nice-to-have.
5. **Telegram message length limits** — Copilot responses can be very long (>4096 chars, Telegram's per-message limit). Need to split or paginate long responses.
6. **parse_mode handling** — current fallback from Markdown to plain text on final edit is basic; consider MarkdownV2 or HTML.

## grammY Stack

- `grammy` (core) — already installed
- `@grammyjs/runner` — long-polling (recommended for personal single-instance daemon)
- `@grammyjs/auto-retry` — automatic retry on 429 rate limits
- `@grammyjs/transformer-throttler` — outgoing message rate limiting

The runner and retry plugins are not yet wired up — Day 1 bot uses `bot.start()` directly.

## Learnings

<!-- Append learnings below -->
