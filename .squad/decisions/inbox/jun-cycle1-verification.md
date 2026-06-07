# Jun — Cycle-1 Verification Report

**Date:** 2026-06-06  
**Author:** Jun  
**Branch:** feature/channel-abstraction  
**Commit:** 823e5d8  
**Baseline:** 946 tests (HEAD=58e1326, all green)  
**After:** 963 tests (17 added, all green)

---

## What Was Added

### R1 — `tests/channel/telegram/telegram-factory.test.ts` (4 tests)

Verifies the Telegram channel factory reads `cfg.chatId` and `cfg.token` from
the resolved `EnvConfig` instead of `process.env` directly.

| Test | Assertion |
|------|-----------|
| R1a | `createChannel('telegram', cfg)` with `TELEGRAM_CHAT_ID` unset and `cfg.chatId=99999` → `allowedChatId === 99999` (not 0) |
| R1b | Bot constructor receives `cfg.token` when `TELEGRAM_BOT_TOKEN` env is unset |
| R1c | Three different `cfg.chatId` values produce channels with matching `allowedChatId` |
| R1d | `cfg.token === undefined` → throws `'TELEGRAM_BOT_TOKEN is required'` |

### B2 — `tests/integration/main-composition.test.ts` (4 tests added)

New `describe('B2 — non-Telegram channel boots without AfkModeController')` block.
`createChannel` is mocked to return a plain object (not instanceof
`MockTelegramChannelClass`, which is TelegramChannel after mocking) so
`channel instanceof TelegramChannel` evaluates to false in `main.ts`.

| Test | Assertion |
|------|-----------|
| B2a | `AfkModeController` NOT constructed |
| B2b | `setMessageInterceptor` NOT called |
| B2c | `console.warn` called with `'AFK mirror currently requires'` |
| B2d | Startup completes without throwing; `channel.start()` called once |

### B1 — `tests/relay/relay.cycle1.test.ts` (5 tests)

`describe('B1 — relay passes RAW text, never calls formatForTransport')`

Drives the real `Relay` with a mock `FakeChannel` across all three capability
branches. `formatForTransport` is a spy; the relay must never call it.

| Test | Case | Assertion |
|------|------|-----------|
| B1a | A (stream+edit) | `formatForTransport` not called |
| B1b | B (no-edit) | `formatForTransport` not called |
| B1c | C (no-stream) | `formatForTransport` not called |
| B1d | A | `editMessage` receives raw session text (not pre-escaped) |
| B1e | B | `sendMessage` receives raw session text, `formatForTransport` not called |

### I2 — `tests/relay/relay.cycle1.test.ts` (4 tests)

`describe('I2 — editMessage false return propagates to "failed to render reply" fallback')`

`channel.editMessage` is mocked to `.mockResolvedValue(false)` (soft-failure,
not throw). Pre-fix `safeEdit` discarded the return value and always returned
`true`, so the fallback never fired. Post-fix `safeEdit` returns
`await channel.editMessage(...)` directly.

| Test | Case | Assertion |
|------|------|-----------|
| I2a | A | `editMessage` call args contain `'_(failed to render reply — see logs)_'` |
| I2b | A | Relay completes without unhandled throw |
| I2c | C | Fallback fires in the no-stream path too |
| I2d | A | `editMessage` throwing (not returning false) still resolves gracefully |

---

## R1 Pre-Fix Failure Confirmation

**Test R1a would have FAILED against the pre-fix factory.** The pre-fix code was:

```typescript
registerChannel('telegram', () =>
  new TelegramChannel(
    new Bot(process.env.TELEGRAM_BOT_TOKEN!),
    Number(process.env.TELEGRAM_CHAT_ID) || 0,
  )
);
```

With `TELEGRAM_CHAT_ID` unset and `cfg.chatId = 99999`:
- `Number(process.env.TELEGRAM_CHAT_ID)` → `Number(undefined)` → `NaN`
- `NaN || 0` → `0`
- `TelegramChannel` constructed with `allowedChatId = 0`
- R1a assertion `expect(allowedChatId).toBe(99999)` → **FAIL (received 0)**

The post-fix factory uses `cfg.chatId ?? 0` → `99999` → **PASS**.

Similarly, R1b would have failed because `new Bot(process.env.TELEGRAM_BOT_TOKEN!)`
with the env var unset passes `undefined` to Bot, not `'cfg-only-token'`.

---

## Findings

**All cycle-1 fixes verified. No new regressions found.**

Specifically:
- R1: factory config resolution — **VERIFIED** (R1a is a genuine discriminating test)
- B1: relay does not call `formatForTransport` — **VERIFIED** (all three cases)
- B2: non-Telegram boot without crash — **VERIFIED** (4 scenarios)
- I2: `editMessage false` → fallback fires — **VERIFIED** (Cases A and C)
- Baseline 946 tests: still all pass

No production code was modified. No test scaffolding workarounds were needed —
the cycle-1 fixes are complete as delivered by Carter and Kat.
