# Jun — History (Phase 1 Complete 2026-06-06, commit 3739640; Persona Review Cycle 2 PASSED 2026-06-07; Phase 2 Queued 2026-06-11)

---

**PHASE 2 KICKOFF (2026-06-11):** Phase 2 Teams adapter plan APPROVED by Aaron. Jun assigned to **P2a-6 (Conformance wiring)** in Phase 2a (open repo, no corp access). P2a-6 creates `tests/channel/conformance/teams.conformance.test.ts` — run conformance kit against TeamsChannel stub with mock Graph client. Depends on P2a-3 (adapter stub). Jun also assigned to P2b-6 (integration testing) in Phase 2b (corp fork, after corp access) — run conformance kit against live TeamsChannel in corp, validate polling latency, rate limits, message round-trip. Locked decisions: OD-1 (edit=false), OD-2 (poll 3s), OD-3 (I4 refactor-first), OD-4 (I5 defer).

**PHASE 1 COMPLETE + PERSONA REVIEW CYCLE PASSED (2026-06-07):** Shipped conformance kit for ChannelPort (behavioral tests + capability-fallback matrix + Telegram anti-lie checks) + full regression suite. 88 new tests added (44 FakeChannel + 44 Telegram); 937 total (up from 849). Zero contract violations found. All 4 capability flags tested in both ON and OFF states. Kat's 3 gotchas pinned. **Two-cycle persona review completed:**
- **Cycle 1 findings:** 3 blocking, 5 important, 4 minor
- **Jun verification (823e5d8):** +17 regression tests covering R1 (4 tests), B2 (4 tests), B1 (5 tests), I2 (4 tests). All findings verified resolved.
- **Cycle 2 outcome:** 0 blocking, all 6 prior important findings verified resolved by all Code Panel personas
- **Final test count:** 963 green (946 + 17 new, all passing). Zero regressions. tsc+lint clean.
- **Ship status:** READY FOR /ship-to-pr
- **Deferred to Phase 2:** I4 (optional createThread), I5 (ChannelMessage union), M5 (central mock factory)

F1 blocker verified in commit 2b5e4a2 (9 new relay capability tests). Reference: Phase 1 section in decisions.md; orchestration log at .squad/orchestration-log/2026-06-07-persona-review-phase1.md. Next: Teams Phase 2 pending corp access.

---

## Learnings

**F1 independent verification (2026-06-06):** Added `tests/relay/relay.capabilities.test.ts` — 9 new relay-level capability tests that drive the REAL relay with mock channels configured for each of Carter's three cases. Key insight: the anti-regression test for Case C (editMessage count stays 1 across 12 chunks) uses fake timers that advance 1000ms per chunk inside the async iterator, which forces the 800ms throttle window to reopen on every iteration. Without timer advancement, the throttle naturally suppresses intermediate edits even on old code — so the timer-advancing approach is essential to make the test truly discriminating at the mechanical level. Primary F1 discriminator for Case C is the "thinking…" vs "…" sendMessage assertion, which unambiguously separates the pre-fix Case A path from the fixed Case C path. Lesson: for throttle-gated behavior, always advance fake timers inside the iterator to make timing assertions meaningful. 946 tests green after adding 9.

**Cycle-1 verification (2026-06-06):** Added 17 new tests across three files to catch R1/B1/B2/I2 regressions that the 946-test suite missed. Key learnings:

1. **Private-field inspection via casting is the right tool for factory tests.** The R1 regression involved a constructor argument being silently wrong (chatId=0 instead of 99999). The adapter is a real class with a private field; the cleanest regression test casts to `unknown as { allowedChatId: number }` to assert the exact value. Behavioral tests (e.g., message filtering) also work but require more scaffolding.

2. **Module-level vi.mock must be hoisted before side-effect imports.** The telegram factory (`registerChannel(...)`) runs at import time and captures the `Bot` constructor from grammy. `vi.mock('grammy')` must appear before the import of `telegram/index.js` so the factory closure sees the mocked Bot. Vitest hoists `vi.mock` calls automatically, making this safe.

3. **Boolean return propagation tests need the return to be soft-failure (not throw).** For I2, if we mocked editMessage to throw, the existing pre-fix code would also fail in safeEdit's `catch` clause (returning false). The discriminating scenario is `editMessage.mockResolvedValue(false)` — a false return that only the post-fix `return await channel.editMessage(...)` propagates. Always think: "what would the pre-fix code do differently?"

4. **B2 (non-Telegram boot) uses instanceof-defeating plain objects.** Since TelegramChannel is mocked to MockTelegramChannelClass in main-composition.test.ts, a plain object literal is not an instance of it and correctly fails the `instanceof TelegramChannel` guard. No need to create a separate class hierarchy.

**PR #11 mock-contract fix (2026-06-07):** Fixed `editMessage: vi.fn().mockResolvedValue(undefined)` → `mockResolvedValue(true)` in 6 test files (cloud-review-1.test.ts, handlers.slashGuard.test.ts, cwdCommand.test.ts, handlers.test.ts, newCwdFlag.test.ts, resume.test.ts) to match ChannelPort's `Promise<boolean>` contract and prevent undefined-as-falsy from triggering relay fallback paths in tests. 972 tests green, tsc+lint clean.

**P2a-6 Teams conformance wiring (2026-06-10):** Created `tests/channel/conformance/teams.conformance.test.ts` — 52 new tests green. Full suite: 1139 passing, tsc+lint clean.

---

## Learnings

**P2a-6: conformance kit against a stub adapter (skipLifecycle + no-dependency pattern, 2026-06-10):**

1. **skipLifecycle + no mock injection.** `TeamsChannel` has no constructor parameters — it is self-contained in-memory. `runChannelPortConformance(() => new TeamsChannel(), { name: 'TeamsChannel', skipLifecycle: true })` is sufficient for the generic kit. The `skipLifecycle: true` flag causes lifecycle `it` blocks to return early without calling `start()`/`stop()`, so the deliberate start-throws behavior does not fail those tests.

2. **I4 optional-createThread assertions.** When `supportsThreadCreation=false` and `createThread` is absent, three assertions lock in the I4 contract:
   - `expect(ch.capabilities.supportsThreadCreation).toBe(false)` — capability flag
   - `expect(ch.createThread).toBeUndefined()` — method absence (not just throws)
   - Caller-guard evaluation: `ch.capabilities.supportsThreadCreation && typeof ch.createThread === 'function'` → `false`
   These are in a dedicated describe block so they are visible and can be adapted for any future absent-method adapter.

3. **Protected dispatch via subclass (TestableTeamsChannel).** `dispatchInboundMessage` and `dispatchInboundCommand` are `protected` on `TeamsChannel`. A minimal `TestableTeamsChannel extends TeamsChannel` subclass that exposes `injectInboundText` and `injectCommand` wrappers allows prompt/inbound tests without touching src/. This is cleaner than `(ch as any).dispatch`.

4. **Microtask flush required for promptUser timing.** `TeamsChannel.promptUser` registers `pendingTextPrompt` and the AbortSignal listener **synchronously** (before `await this.sendMessage(...)`). Tests that inject inbound text or fire an abort signal do not need a microtask flush for the registration itself, but `await Promise.resolve()` is retained as a defensive guard to let any async setup in promptUser settle before the test acts. `await Promise.resolve()` (one microtask tick) is sufficient — `setTimeout(resolve, 0)` (macrotask) was overkill.

**Test file path:** `tests/channel/conformance/teams.conformance.test.ts`

---

**Persona review cycle 1 fixes (2026-06-11, commit e249fb0):**

5. **FakeChannel.injectInboundText locked to contract (Finding D).** The old implementation routed unmatched replies (during a pending prompt) to the messageHandler — contradicting the locked promptUser contract. Fixed to: trimmed+case-insensitive value matching OR 1-based index; if unmatched, silently ignore (return early, do NOT call messageHandler). This aligns FakeChannel with TeamsChannel.dispatchInboundMessage behavior.

6. **Minimal no-createThread adapter for I4 optional-method contract (Finding D1b).** `makeMinimalNoThreadPort()` in runner.ts returns a plain object implementing ChannelPort with NO `createThread` property at all. FakeChannel's throwing stub gave false confidence about the "method omitted" path — the new test drives the genuinely absent path (`typeof port.createThread === 'undefined'`). This is how Teams-style adapters work in practice.

7. **flushPromises (setTimeout(0)) → await Promise.resolve() (Finding K).** Real timers in a conformance test were unnecessary. `pendingTextPrompt` is now set **synchronously** at the top of `promptUser` (before `sendMessage` is called), so a macrotask flush was never required for ordering. `await Promise.resolve()` is kept as a lightweight defensive guard — one microtask tick to let promptUser's async frame initialize — but it is not load-bearing for registration ordering. Changed in teams.conformance.test.ts; promptUser.test.ts already used the microtask pattern.

8. **Minimal promptUser block in teams.conformance.test.ts (Finding L).** Trimmed to 4 assertions: pre-abort→'', matching value, matching index (1-based), unmatched→handler not called. Mid-abort and pending-resolution edge cases left in promptUser.test.ts. Rule: conformance kit = minimal contract; unit tests = exhaustive edge cases.

**PR #12 Copilot review fix (2026-06-11, commit e5633d7):**

9. **makeMinimalNoThreadPort() now genuinely exercises the omitted-createThread path.** The prior cycle 1 fix created `makeMinimalNoThreadPort()` but the test that claimed to test the absent-method path still used `new FakeChannel({ supportsThreadCreation: false })`. FakeChannel defines `createThread` as a throwing method — so `typeof port.createThread === 'function'` was `true` and `canCreate` evaluated to `false` only because of the capability flag, NOT because the method was absent. The fix replaces the subject with `makeMinimalNoThreadPort()` (a plain object with NO `createThread` property) and asserts the real contract: `typeof port.createThread === 'undefined'`, `canCreateThread(port) === false`, and `port.capabilities.supportsThreadCreation === false`. Also imports the canonical `canCreateThread` guard from `port.ts` instead of a hand-rolled check. `makeMinimalNoThreadPort()` is now used, eliminating the dead helper. The `supportsThreadCreation=true` path (FakeChannel with callable createThread) and the throwing-stub variant remain covered by their own tests — both sides of the contract are exercised.