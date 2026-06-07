# Jun — History (Phase 1 Complete 2026-06-06, commit 3739640; Persona Review Cycle 2 PASSED 2026-06-07)

---

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

---