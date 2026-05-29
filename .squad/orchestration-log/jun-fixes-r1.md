# Jun Fixes Round 1
**Timestamp:** 2026-04-12T08:34:00Z  
**Agent:** Jun (fix author)  
**Status:** COMPLETED

## Summary
Fixed test reliability in relay.test.ts. Mid-stream test required real timing adjustment.

## Changes
### relay.test.ts
1. ✅ **failAfter race fix** — Changed `failAfter=0` to `failAfter=1` to allow real mid-stream failure (first chunk delivers, second fails)

## Rationale
`failAfter=0` would prevent even the first event from emitting, making test unrealistic. With `failAfter=1`, the stream produces one chunk before failing, testing actual mid-stream error recovery.

## Test Results
- ✅ 56/56 tests passing
- ✅ All relay error paths covered
