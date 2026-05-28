# Carter Fixes Round 1
**Timestamp:** 2026-04-12T08:30:00Z  
**Agent:** Carter (fix author)  
**Status:** COMPLETED

## Summary
Fixed blocker (ensureStarted race) and all 4 should-fixes in impl.ts and main.ts.

## Changes
### impl.ts
1. ✅ **ensureStarted() race** — Added startPromise memoization with `.catch(() => null)` recovery
2. ✅ **Stream timeout** — AbortController with 5-min timeout; cancels pending edits
3. ✅ **resume() error discrimination** — Re-throws non-existence errors to preserve SDK connection faults
4. ✅ **Shutdown idempotency** — Added guard `if (!this.started) return` to stop()

### main.ts
1. ✅ **Relay disposal** — Added relay disposal hook to factory.stop()
2. ✅ **NaN chatId guard** — Added Number.isNaN() check before handler registration
3. ✅ **Shutdown sequencing** — Promise.allSettled ensures independent teardown

## Test Results
- ✅ 56/56 tests passing
- ✅ TypeScript clean
