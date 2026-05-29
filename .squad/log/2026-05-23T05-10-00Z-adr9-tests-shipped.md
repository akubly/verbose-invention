# Session Log: ADR-9 Tests Shipped

**Timestamp:** 2026-05-23T05:10:00Z  
**Phase:** 6 (ADR-9 Permission-Prompting)  
**Status:** COMPLETE

## Summary

Phase 6 ADR-9 permission-prompting **fully shipped** — implementation reconciliation + 32-scenario test coverage both green.

- **Tests:** 353 pass, 4 skipped, 0 failures
- **New scenarios:** 32 (all live under `tests/bridge/`)
- **Implementation:** Per-session AllowAlwaysStore isolation + extension.mjs named exports
- **Bug found:** Real security violation in reconciliation (per-session store was shared — now fixed)

## Key Finding

Reconciliation surfaced a critical security issue: `AllowAlwaysStore` was shared across sessions in previous code, violating session isolation. Fixed in this batch. Test harness requires `vi.mock` for extension.mjs side effects — documented for future test runs.

## Next Phase

Live end-to-end dogfooding against real Copilot CLI session over the pipe (Day 5+).
