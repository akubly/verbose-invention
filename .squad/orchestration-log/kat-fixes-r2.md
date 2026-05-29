# Kat Fixes Round 2
**Timestamp:** 2026-04-12T08:55:00Z  
**Agent:** Kat (fix author)  
**Status:** COMPLETED

## Summary
Fixed startPromise latch issue in impl.ts and version validation in registry.ts. Both Round 2 flags resolved.

## Changes
### impl.ts
1. ✅ **startPromise latch** — Modified catch handler to reset `this.startPromise = null`, enabling clean retry on next call

### registry.ts
1. ✅ **Version validation on load** — Added explicit check for `schemaVersion` field presence and value; rejects malformed registry

## Test Results
- ✅ 56/56 tests passing
- ✅ TypeScript clean
