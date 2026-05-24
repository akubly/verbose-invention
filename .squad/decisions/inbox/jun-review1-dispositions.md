# Jun — Review Cycle 1 Dispositions

**Date:** 2026-05-22  
**Branch:** `squad/review1-phase6-adr9-fixes`  
**Commit:** 328f48a

---

## I3 — DESTRUCTIVE_TOOLS / SAFE_TOOLS drift detection missing

**Disposition:** ACCEPT and fix.

**Reasoning:** The concern is real and material. `extension.mjs` carries hardcoded copies of both sets with a "MUST be mirrored" comment that relies entirely on author discipline. Any tool added to `permissions.ts` without a matching update in `extension.mjs` would silently bypass risk classification — the extension's `isDestructive()` call would return false and the tool would execute without a Telegram approval prompt. That is a privilege escalation bug, and there is currently zero automation preventing it.

**Approach chosen:** (b) — keep two sources, add a drift-detection test. Faster to land and avoids rearchitecting the extension's module format just for this concern. The test parses `extension.mjs` as raw text via regex and compares to the TypeScript exports. If the sets drift, the test fails at CI time before the branch can merge.

**Current state:** Sets are **in sync** today. Both assertions pass green. The third assertion (no overlap between DESTRUCTIVE and SAFE) also passes and guards against a different category of classification error.

**Fix delivered:** `tests/copilot/permissions-drift.test.ts` (3 tests, all green).

---

## I8 — FakeDaemon ships unresolved TODO + missing PermissionResponseMessage

**Disposition:** ACCEPT and fix.

**Reasoning:** The stale TODO was valid during initial construction (Carter hadn't merged the pipe protocol). As of Phase 6, ADR-8 is final and ADR-9 is accepted — the canonical types are locked in `src/bridge/extensionBridge.ts`. The TODO is now false advertising, and the missing ADR-9 types (`PermissionRequestMessage`, `PermissionCancelledMessage`, `PermissionResponseMessage`) mean the FakeDaemon cannot be used to write ADR-9 integration tests without casting. That blocks Category 2 and 3 permission test scenarios.

**Audit result (InboundMessage — extension → daemon):**
| Type | In FakeDaemon before | Status |
|---|---|---|
| `hello` (HelloMessage) | ✅ | OK |
| `pong` (PongMessage) | ✅ | OK |
| `stream` (StreamChunkMessage) | ✅ | OK |
| `stream.error` (StreamErrorMessage) | ✅ | OK |
| `session.event` (SessionEventMessage) | ✅ | OK (added Phase 6 Day 2) |
| `permission.request` (PermissionRequestMessage) | ❌ | **ADDED** |
| `permission.cancelled` (PermissionCancelledMessage) | ❌ | **ADDED** |

**Audit result (OutboundMessage — daemon → extension):**
| Type | In FakeDaemon before | Status |
|---|---|---|
| `ping` (PingMessage) | ✅ | OK |
| `session.registered` (SessionRegisteredMessage) | ✅ | OK |
| `inject` (InjectMessage) | ✅ | OK |
| `permission.response` (PermissionResponseMessage) | ❌ | **ADDED** |

**Wire shapes confirmed** to match `extensionBridge.ts` field-for-field. Types defined locally in FakeDaemon (not imported from production) — maintains test isolation, consistent with existing pattern.

**TODO removed.** The contracts are now aligned; the TODO was no longer describing open work.

**Fix delivered:** `tests/helpers/FakeDaemon.ts` updated (+3 types, +3 union members, TODO removed).

---

## Integration test hang — discovery

**Not a finding I was assigned**, but surfaced during `npx vitest run` (full suite): `tests/integration/pairing-flow.test.ts` hangs indefinitely. This is pre-existing — nothing in my changes touches integration test infrastructure or the pairing flow. All 340 non-integration tests pass cleanly.

**Recommendation:** Escalate to Carter or Noble Six. The pairing-flow integration test is likely blocking on a real named-pipe connection that cannot be established in the CI environment.

---

## Verification Summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ clean (0 warnings) |
| `npx vitest run` (excluding integration) | ✅ 340 passed / 4 skipped / 0 failed |
| New I3 drift tests | ✅ 3/3 green |
| Existing FakeDaemon-dependent tests | ✅ all green (no regressions) |
