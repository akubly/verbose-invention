# Jun Cycle 4 Phase 8 Backlog

Items deferred from the Cycle 4 review wave to keep scope contained. Tracked
here for follow-up planning before or during Phase 8.

Updated after Cycle 5 (architect5 findings incorporated).
Updated after Cycle 6 (Skeptic6 flag on A8, architect6 A6-6 watch).
Updated after Cycle 7 (triage pass, W7-3 design note, M7-5 citation).

---

## Triage (Cycle 7)

Classification of all open items before Phase 8 implementation begins.
Buckets: **P1** (must address before Phase 8 ships), **P2** (nice-to-have,
address opportunistically), **Triggered watch** (no action until trigger fires).

| Item | Bucket | Size | Notes |
|---|---|---|---|
| A8 REOPENED | P1 | M | Gates Phase 8 composition-root closure; two integration tests needed — **Why P1:** composition-root branches untested → regression risk during Phase 8 wiring changes |
| A7 | P1 | S | Inbound shape coverage missing; small addition to existing drift test — **Why P1:** shape mismatch at runtime is undetectable without coverage |
| N2 | P1 | S | Guard code drafted in backlog, not yet landed; env-var test variant also needed — **Why P1:** deny-all misconfiguration via config JSON goes undetected → silent lockout risk |
| N3 | P1 | S | End-to-end config-branch path through main() unverified — **Why P1:** config-layer allowed IDs path never exercised → silent breakage if wiring changes |
| A2 | P2 | — | Defer until first relay error code is added; single rename then is cheap |
| F8 | P2 | — | No `/approve` commands yet; extract when dynamic auth arrives |
| F4 watch | Triggered watch | — | Trigger: second compensation path OR afkMode.ts ≥ 700 LOC |
| F5 watch | Triggered watch | — | Trigger: AfkBridgePort event count ≥ 8 or two unrelated domains |
| A6-6 watch | Triggered watch | — | Trigger: session count > 15 or observable 429 retries in logs |
| Module isolation note | P2 | — | Guidance for future main.ts test authors; no active work needed |

**Test-coverage sprint:** A7, N2, and N3 are all S and mechanically similar
(add assertions / guard / integration test with no new production logic).
Group them into a single sprint. A8 is M and architecturally distinct
(integration harness for main() branches) — tackle immediately after or in
parallel, but track separately.

---

## A8 — Composition root validation (REOPENED Cycle 6)

Previously closed on LOC reduction (main.ts 221→90). Skeptic6 correctly
flagged (Cycle 6 persona-review) that LOC alone is not "composition root proven clean." Still missing:

- End-to-end smoke test for `main()` pairing-mode early-return path
- End-to-end smoke test for `main()` config-file env resolution branch
- (No new code; gates closure on having those tests)

**Target:** Phase 8 — small integration test harness for main() that mocks
process.env and verifies the two branches behave correctly without
actually starting grammY/bridge servers.

---

## ✅ CLOSED — A8 / F1 / I5-3 — Composition root extraction (original)

`main.ts` was 221 LOC at the start of Cycle 5. Kat's I5-3 (`src/config/env.ts`,
`src/bot/pairing.ts`) reduced it to ~90 LOC. LOC reduction complete.
Carter's I5-2 (`src/bin.ts`) also cleaned up the entry-point boundary.
(See A8 REOPENED above for outstanding test coverage gate.)

---

## Open items

### A2 — ERROR_CODES namespacing

As the relay feature lands and relay error codes are added, `ERROR_CODES` should
be namespaced to avoid a flat, collision-prone object. Proposed shape:

```ts
ERROR_CODES.AFK.*   // existing afk codes
ERROR_CODES.RELAY.* // relay codes (when relay arrives)
```

Defer until the first relay error code is added; a single rename commit at that
point is cheaper than pre-partitioning now.

### A7 — Extend drift test to inbound message shapes

The existing M6 drift test (Carter) checks outbound protocol message shapes.
Inbound shapes (afk.request, back.request, hello, pong, stream.*) are not
covered. Add assertions for these in the drift test before Phase 8 ships.

### F4 watch — Compensation pattern extraction

When a second compensation path appears (e.g., relay activation rollback) OR
`afkMode.ts` exceeds 700 LOC, extract `compensatePartialActivation` into a
shared utility. Currently a single-use internal method; premature extraction
would obscure the data flow without benefit.

**Design note (architect7):** If compensation becomes independently callable
(not just an activate-failure artifact), evaluate splitting `activationPromise`
into separate `activationPromise` + `compensationPromise` so callers can await
each concern independently. Today unified is correct because compensation is
structurally embedded in activate's catch.

### F5 watch — AfkBridgePort split

`AfkBridgePort` currently carries 5 event types. When the count reaches 8 or
the interface spans two unrelated domains, split into focused sub-ports. Track
the current count when adding relay events.

### F8 — AuthorizationPort interface for dynamic auth

When `/approve` commands or dynamic allow-list management land, the inline
`allowedUserIds` option on `AfkModeOptions` will not scale. Extract an
`AuthorizationPort` interface so the auth strategy is injectable and testable
independently.

### N2 — Deny-all misconfiguration: `allowedUserIds: Set([])`

ADR-11 D3 notes that `allowedUserIds: Set([])` is an explicit deny-all state
and should be treated as a misconfiguration, not as unset. The current startup
check catches the empty-string case at the env-var layer (`TELEGRAM_ALLOWED_USER_IDS=""`
after trim → fatal exit), but `Set([])` produced by config JSON `telegramAllowedUserIds: []`
is not detected. **Status:** Guard code drafted below but not yet landed in production.
A follow-up should add a guard:

```ts
if (allowedUserIdSet !== undefined && allowedUserIdSet.size === 0) {
  console.error('[reach] Fatal: allowedUserIds is empty — this would deny all users. Unset to allow all, or provide at least one ID.');
  process.exit(1);
}
```

The current behavior is documented by the `N2 (backlog)` test in
`tests/config/env.test.ts` (M5-4).

Env-var test coverage should include a test for `TELEGRAM_ALLOWED_USER_IDS=,`
(all tokens empty after split → current fatal path) and a separate test for a
future `size === 0` guard.

### N3 — Config-layer allowed IDs: integration coverage

`telegramAllowedUserIds` in `config.json` sets `allowedUserIdSet` via the
`else if` branch in `parseEnv()`. The happy-path and invalid-config guard are
now covered by `tests/config/env.test.ts` (M5-4 direct tests). A follow-up
integration test should verify the end-to-end path through `main()` to confirm
the config-file branch is wired correctly in the composition root.

---

## Architect Watch (ongoing)

### A6-6 — Compensation parallel close burst (Cycle 6 watch)

`compensatePartialActivation` fires `closeForumTopic` for all rolled-back
bindings via `Promise.all` — no rate-limit pacing. At small N (≤5
sessions) the `withRateLimitRetry` per-call handles 429s. Watch threshold:
if session count grows past ~15 OR if Telegram 429 retries become
observable in logs, batch closes in groups of 5 with a small gap.

Source: architect6 review, Cycle 6.

### Module isolation for `main.ts`

`tests/config/env.test.ts` now imports `parseEnv` directly, removing the
13-mock `main.ts` wrapper for env tests (M5-4). If future `main.ts` tests need
to vary mock implementations per-test (e.g., different `loadConfig` responses),
use `vi.resetModules()` + dynamic `await import(...)` for fresh module instances.
