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

4. **Microtask flush required for promptUser timing.** `TeamsChannel.promptUser` does `await this.sendMessage(...)` before setting `pendingTextPrompt` and registering the AbortSignal listener. Tests that inject inbound text or fire an abort signal must flush the microtask queue first (via `await new Promise<void>(resolve => setTimeout(resolve, 0))`) or the inject/abort races ahead of the setup and the promise never resolves.

**Test file path:** `tests/channel/conformance/teams.conformance.test.ts`

---