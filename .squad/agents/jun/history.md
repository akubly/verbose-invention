# Jun — History

## Core Context

- **Project:** Reach — a TypeScript daemon bridging Telegram to GitHub Copilot CLI sessions on a personal Windows machine via named session registry and bidirectional streaming.
- **Role:** Tester
- **Joined:** 2026-04-12T06:02:10.441Z

## Project Background

Reach is Aaron's personal mobile bridge for Copilot CLI. I'm Jun — I own the test strategy and test coverage. Stack: Vitest (run with `npm test`). The project uses dependency injection throughout (interfaces, not concrete implementations) which makes unit testing straightforward.

## Test Infrastructure (Day 1)

Test mocks scaffolded in `tests/mocks/`:
- `sdk.ts` — mock `CopilotClient` and `CopilotSession`
- `telegram.ts` — mock Telegram context/API

Test directories: `tests/bot/`, `tests/relay/`, `tests/sessions/`

## What Needs Tests (Priority Order)

1. **`SessionRegistry`** — load, register, resolve, list, remove; ENOENT on first load; JSON persistence round-trip
2. **`Relay`** — happy path relay, no-session-found error, SDK create/resume errors, streaming throttle timing, idle eviction
3. **`IdleMonitor`** — timer fires after idle period, reset cancels previous timer, cancelAll
4. **`registerHandlers`** — `/new` success/failure/duplicate, `/list` empty/populated, `/remove` found/not-found, non-command relay dispatch

## Testing Principles

- Unit tests only for the first sprint — no integration tests yet (no real Telegram, no real SDK)
- All tests use mock implementations — never the real SDK or real grammY bot
- Test file location: `tests/<module>/<file>.test.ts` mirroring `src/`
- The `CopilotClient` stub in `src/copilot/factory.ts` exists for dev; tests should use their own mocks (finer control)

## Key Constraint

**Tests must not import `@github/copilot-sdk` directly.** The interface boundary (`src/types.ts`) is what tests mock against — the real SDK binding is Noble Six's concern.

## Learnings

<!-- Append learnings below -->
