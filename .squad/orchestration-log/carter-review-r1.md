# Carter Review Round 1
**Timestamp:** 2026-04-12T08:16:00Z  
**Agent:** Carter (reviewer)  
**Status:** REQUEST CHANGES

## Summary
Reviewed Noble Six's impl.ts and main.ts. Found 1 blocker and 4 should-fixes in startup/shutdown logic.

## Findings
### Blocker ❌
1. **ensureStarted() race** — startPromise not memoized; concurrent resume/create calls trigger multiple SDK starts
   - **Fix required:** Memoize startPromise with `.catch(() => null)` fallback to allow retry

### Should-Fixes 🟡
1. **Stream timeout not enforced** — 5-min timeout design mentioned but not implemented
   - **Fix:** Add AbortController with 5-min timeout to stream loop
2. **resume() error discrimination** — catch-all try/catch masks SDK errors
   - **Fix:** Rethrow non-existence errors to preserve connection faults
3. **Shutdown not idempotent** — stop() called twice crashes
   - **Fix:** Add guard: `if (!this.started) return`
4. **Relay disposal not called** — factory.stop() leaves relay connections dangling
   - **Fix:** Add relay disposal hook to factory.stop()

## Outcome
Critical: fix blocker before merge. Should-fixes improve robustness; all needed for test suite to pass.
