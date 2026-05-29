# Jun Review Round 1
**Timestamp:** 2026-04-12T08:17:00Z  
**Agent:** Jun (reviewer)  
**Status:** REQUEST CHANGES

## Summary
Reviewed all production code across impl.ts, main.ts, registry.ts, handlers.ts, factory.ts, idleMonitor.ts. Found 1 blocker and 7 should-fixes affecting test reliability and data safety.

## Findings
### Blocker ❌
1. **Registry persistence not atomic** — concurrent writes corrupt JSON
   - **Fix required:** Use write-to-temp + atomic rename pattern; add corrupt JSON recovery

### Should-Fixes 🟡
1. **Schema version not validated on load** — registry.json format changes silently accepted
   - **Fix:** Add schema version field; reject mismatched versions
2. **chatId validation missing in handlers** — undefined chatId passes through
   - **Fix:** Guard relay() call with chatId check
3. **Resume stub returns undefined** — factory.ts test stub doesn't match interface
   - **Fix:** Explicitly return null for "not found" case
4. **Environment variable validation missing** — idleMonitor uses process.env without guards
   - **Fix:** Validate env vars at startup, fail fast
5. **NaN chatId not guarded in main.ts** — parseInt() result unchecked
   - **Fix:** Add Number.isNaN() guard before handler registration
6. **Relay disposal never called** — factory.stop() needs cleanup hook
   - **Fix:** Track relays in factory, dispose all on stop()
7. **Stream timeout not implemented** — design mentions 5-min but code missing
   - **Fix:** AbortController + timeout handler

## Outcome
Critical: fix blocker + env validation before merge. Test suite designed to catch all findings; ensure all 56 tests pass after fixes.
