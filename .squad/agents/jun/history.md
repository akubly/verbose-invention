# Jun — History (Phase 1 Complete 2026-06-06, commit 3739640)

---

**PHASE 1 COMPLETE (2026-06-06):** Shipped conformance kit for ChannelPort (behavioral tests + capability-fallback matrix + Telegram anti-lie checks) + full regression suite. 88 new tests added (44 FakeChannel + 44 Telegram); 937 total (up from 849). Zero contract violations found. All 4 capability flags tested in both ON and OFF states. Kat's 3 gotchas pinned. 937 tests green (zero regressions). Orchestration log: `.squad/orchestration-log/2026-06-06T21-14-08-jun.md`. Phase 1 awaiting Noble Six review (concurrent, read-only). Reference: Phase 1 section in decisions.md.

---

## Learnings

**F1 independent verification (2026-06-06):** Added `tests/relay/relay.capabilities.test.ts` — 9 new relay-level capability tests that drive the REAL relay with mock channels configured for each of Carter's three cases. Key insight: the anti-regression test for Case C (editMessage count stays 1 across 12 chunks) uses fake timers that advance 1000ms per chunk inside the async iterator, which forces the 800ms throttle window to reopen on every iteration. Without timer advancement, the throttle naturally suppresses intermediate edits even on old code — so the timer-advancing approach is essential to make the test truly discriminating at the mechanical level. Primary F1 discriminator for Case C is the "thinking…" vs "…" sendMessage assertion, which unambiguously separates the pre-fix Case A path from the fixed Case C path. Lesson: for throttle-gated behavior, always advance fake timers inside the iterator to make timing assertions meaningful. 946 tests green after adding 9.

---