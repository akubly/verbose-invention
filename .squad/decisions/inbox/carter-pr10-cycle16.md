# Carter PR #10 — Cycle 16 Decisions

**Date:** 2026-06-06  
**Branch:** user/aaron/phase9 @ d899d41

---

## T1 — BOT_COMMAND_NAMES: DELETE (Case A: genuinely dead)

### Investigation

`BOT_COMMAND_NAMES` was introduced in cycle 3 as a shared command registry alias:

```ts
// src/bot/commands.ts:36
export const BOT_COMMAND_NAMES = BOT_COMMANDS;
```

**Grep evidence — zero live references:**

```
src/      → no references outside the definition itself
tests/    → no references at all
```

Only non-code mentions found:
- `.squad/agents/carter/history.md` — historical narrative, not a code reference
- `.squad/decisions.md` — two mentions, both documenting past decisions:
  1. "Added alias export `BOT_COMMAND_NAMES` and startup drift check in `registerHandlers`" — the drift check was subsequently removed
  2. "alias kept for isBotCommand.test.ts" — that test imports only `isBotCommand` and `BOT_COMMANDS`, not `BOT_COMMAND_NAMES`

**No hardcoded duplicates to wire up.** The codebase uses `BOT_COMMANDS` (the actual `ReadonlySet`) everywhere it needs the set. Nothing is hardcoding a second command-name list that `BOT_COMMAND_NAMES` should be driving.

### Decision

**DELETE.** Case (a): genuinely dead export. The drift check it was originally paired with was removed in a prior cycle; `isBotCommand.test.ts` does not import it. YAGNI applies — a future consumer can re-add if needed.

**Change:** Removed line 36 from `src/bot/commands.ts`. No test imports required updating.

---

## T2 — handlers.slashGuard.test.ts file header: REWRITTEN

The "RED tests (awaiting Carter)" / "⚠️ EXISTING TEST CONFLICT" header was stale. The implementation landed in this PR: `isBotCommand()` guard is live in `handlers.ts`, and `handlers.test.ts` was already updated to use `/list` instead of `/unknown-cmd`. Rewrote the header to describe present reality.

---

## T3 — handlers.slashGuard.test.ts inline scaffold comments: REMOVED

Removed "RED until Carter:" inline comments from test bodies (5 occurrences). Replaced the stale conflict note in the `/unknowncommand` test with a factual note that `handlers.test.ts` was already updated in this PR. Removed stale section heading suffix "(RED until Carter)".

---

## Extra — afkMode.slashGuard.test.ts: same treatment applied

`tests/relay/afkMode.slashGuard.test.ts` carried the same generation of TDD scaffold (file header "RED tests (awaiting Carter)", 5 inline "RED until Carter." body comments, stale section heading). Carter's AFK guard change is also live in this PR. Applied identical cleanup: rewrote header to describe current reality, removed inline RED scaffolding.

## Extra — isBotCommand.test.ts: stale anticipatory header and B1 describe label

- File header: removed "RED until Carter lands src/bot/commands.ts" / "Expected import failure" framing; the module is live.
- `describe('isBotCommand — B1: digit handling (anticipatory)')` → removed "(anticipatory)" suffix and the "RED until Carter lands the regex change" block comment above it; the fix has landed.
