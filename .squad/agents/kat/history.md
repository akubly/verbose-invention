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

### 2026-04-12 — Code Review Fix Pass (Carter lockout)

Fixed 5 issues found by review panel in Carter's files, acting as independent author:

1. **Registry crash-safety** — `persist()` now writes to `.tmp` then renames (atomic). `load()` handles corrupt JSON by backing up and starting fresh.
2. **Registry schema version** — Added `version: 1` to `RegistryData` for future migration support.
3. **chatId fallback** — Replaced `ctx.chat?.id ?? 0` with an early guard that replies with an error instead of writing bogus data.
4. **Stub resume()** — Changed `StubCopilotSessionFactory.resume()` from throwing to returning `null`, matching the interface contract (resume→null→create fallback).
5. **IDLE_TIMEOUT_MS validation** — Added `Number.isFinite` + positive check to prevent NaN/negative timer values.

All 56 tests pass after changes.

### 2026-04-12 — Phase 2 Go Live: Required Chat ID + /help Command

Two P0/P1 changes for the Go Live phase:

1. **TELEGRAM_CHAT_ID now required** — Prevents the bot from responding to all groups if Aaron accidentally adds it to a shared group. `src/main.ts` now fails immediately with a fatal error if `TELEGRAM_CHAT_ID` is missing. `createBot()` signature changed to require `allowedChatId: number` (no longer optional). The chat guard middleware is now unconditional.

2. **/help command added** — New command in `src/bot/handlers.ts` shows the list of available commands and what Reach does. Keeps the UX simple — user can discover commands without reading docs.

TypeScript compilation clean, all 73 tests pass.

### 2026-04-14 — Phase 2 Review Cycle: Env & Security Fixes (Independent Author)

Persona review flagged two env/main.ts items. As independent author, applied 2 fixes:

1. **.env.example alignment** — Inconsistent variable names and missing documentation. Aligned all environment variable names to match code constants, removed alternate spellings, added clarification for required vs optional vars. Each var now documents its purpose, example value, and format.

2. **Masked chat ID in main.ts** — Removed hardcoded test chat ID from source code. Added safety guidance to documentation on setting `TELEGRAM_CHAT_ID` securely without committing secrets.

**Verification:** All 81 tests pass. No behavioral changes.

### 2026-04-14 — Phase 3: README & /new --model Command

Created comprehensive README.md and implemented per-session model selection:

1. **README.md (P0)** — Complete setup guide at project root covering:
   - What Reach is (one-paragraph explanation)
   - Architecture (daemon ↔ Telegram ↔ Copilot SDK via forum topics)
   - Prerequisites (Node.js 20+, Telegram bot token, forum-enabled supergroup, Copilot CLI access)
   - Setup steps (clone, install, .env config, build, run/service install)
   - Usage (/new with optional --model flag, /list, /remove, /help)
   - Environment variables table (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, REACH_MODEL, IDLE_TIMEOUT_MS)
   - Windows Service details (service:install/uninstall, NetworkService account, auto-restart)
   - Development commands (test, typecheck, build, dev watch mode)

2. **/new --model flag parsing** — Updated `src/bot/handlers.ts`:
   - Parse `--model <value>` from `/new` command input via regex
   - Pass model as 4th parameter to `registry.register(topicId, chatId, name, model)`
   - Success message shows model if set: `✅ Session \`name\` registered (model: claude-opus-4.5).`
   - Error handling: `--model` with no value shows error containing "model value"
   - Guards: check for `--model` presence first, then validate regex match and capture groups

3. **/list model display** — Updated to show model when set:
   - `• my-session ← topic #123 (model: claude-opus-4.5)`
   - `• other-session ← topic #456` (no model note when undefined)

4. **/help updated** — Command signature now shows:
   - `/new <name> [--model <model>] — Create a session in this topic`

**Test alignment:** Updated 2 existing tests to expect 4th parameter (undefined when --model not provided). Jun had already written 26 new tests for --model feature in parallel (tests/bot/handlers.test.ts).

**Verification:** TypeScript compiles clean, all 107 tests pass (81 → 107, +26 for model feature).

**Pattern learned:** When coordinating parallel changes (Carter updating registry, Kat updating handlers), tests act as the integration contract — Jun wrote tests expecting both changes, so when both are done, tests pass.

