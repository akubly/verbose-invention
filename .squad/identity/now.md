---
updated_at: 2026-05-19T22:13:42Z
focus_area: Phase 6 FULLY LOCKED — 7 ADRs finalized. Option B (extension bridge) confirmed. Daemon single-user, exponential backoff, heartbeat ping/pong+teardown. Day 1 tasks assigned to Carter, Kat, Jun — all can start in parallel.
active_issues: [Implementation kickoff Day 1 — Carter (named-pipe server), Kat (install.ts refactor), Jun (test doubles)]
---

# What We're Focused On

**Phase 6: Session 0 Control Plane + Extension-Bridge Data Plane — LOCKED FOR IMPLEMENTATION**

Phases 1–5 shipped. Aaron dogfooding Reach. Phase 6 architecture **FULLY LOCKED** as of 2026-05-19T22:13:42Z.

## Architecture — LOCKED

**ADRs 1–7 Finalized:**
1. ✅ **ADR-1:** Copilot CLI Extension API for session attach (no port discovery, push-based registration)
2. ✅ **ADR-2:** Push-based discovery with `listSessions()` fallback
3. ✅ **ADR-3:** Single named pipe `\\.\pipe\reach-bridge`, JSON-Lines, multiplexed by sessionId
4. ✅ **ADR-4:** Extension crash = session unreachable (no auto-recovery; user restarts CLI)
5. ✅ **ADR-5:** Daemon runs as logged-in user, NOT LocalSystem (fixes `LookupAccountName` bug)
6. ✅ **ADR-6:** Extension reconnect policy = exponential backoff (base 1s, ceiling 300s, never give up)
7. ✅ **ADR-7:** Heartbeat = ping/pong (30s interval) + pipe-teardown detection (<1s typical, ≤50s worst-case)

**Implementation gates closed:**
- ✅ Phase 6 scope = LOCKED (Option B with extension bridge)
- ✅ All 3 of Jun's hard blockers answered (pipe security, reconnect spec, heartbeat)
- ✅ Noble Six ADRs 1–7 finalized and in canonical ledger (`.squad/decisions.md`)

## Day 1 Task Assignments (Parallel)

| Owner | Deliverable | Start | Dependencies |
|-------|-------------|-------|---|
| **Carter** | `src/bridge/extensionBridge.ts` (pipe server) + `extension.mjs` skeleton | Now | None |
| **Kat** | `src/service/install.ts` refactor (user-account service) | Now | None |
| **Jun** | `test/helpers/FakeDaemon.ts` + `test/helpers/FakeExtensionClient.ts` | Now | None |

All three tasks have no hard data dependencies and can begin immediately in parallel.

**Latest artifacts:**
- Decisions: `.squad/decisions.md` (Phase 6 architecture locked with 7 ADRs)
- Orchestration: `.squad/orchestration-log/2026-05-19T2213-phase6-adr-lock.md`
- Session log: `.squad/log/2026-05-19T2213-phase6-adr-lock.md`

