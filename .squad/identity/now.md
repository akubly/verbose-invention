---
updated_at: 2026-05-22T19:56:00Z
focus_area: Phase 6 Days 3–4 COMPLETE — BridgeSession adapter + composite factory wired; relay inherits all 800ms throttle + MarkdownV2 + splitter logic over the bridge for free. 316 tests green. Day 5+ end-to-end dogfooding next.
active_issues: [Day 5+ — end-to-end testing against a live CLI session over the pipe; permission-prompting over bridge (ADR-9 future); production readiness.]
---

# What We're Focused On

**Phase 6: Session 0 Control Plane + Extension-Bridge Data Plane — DAYS 3–4 COMPLETE, RELAY ON BRIDGE**

Phases 1–5 shipped. Aaron dogfooding Reach. Phase 6 Days 1–2 (ADR-8 protocol) committed. **Days 3–4 (relay-on-bridge) complete and green.** Telegram messages can now flow over the extension pipe with zero changes to the relay's battle-tested throttle/MarkdownV2/splitter logic.

## Phase 6 Days 3–4 Summary

**Code Delivered (Kat):**
- ✅ `src/bridge/bridgeSession.ts` — `BridgeSession implements CopilotSession`; push-to-pull async-iterator adapter with guaranteed listener cleanup
- ✅ `src/bridge/bridgeSessionFactory.ts` — `CopilotSessionFactory` over the bridge
- ✅ `src/bridge/compositeSessionFactory.ts` — bridge-first, SDK-fallback (no config flag; graceful coexistence)
- ✅ `src/bridge/extensionBridge.ts` — added `getSessionByName()` to map relay's session names to bridge `sessionId`
- ✅ `src/main.ts` — wired bridge + composite factory; graceful fallback if pipe unavailable on startup
- ✅ New skill: `push-to-pull-async-iterator`

**Tests Delivered (Jun):**
- ✅ `tests/bridge/bridgeSession.test.ts` (10 cases — single/multi-chunk, error, foreign-requestId filter, unreachable, listener-cleanup on success/error/abandon, pre-iterate buffering, empty completion)
- ✅ `tests/bridge/bridgeSessionFactory.test.ts` (6 cases)
- ✅ `tests/bridge/relay-with-bridge.test.ts` (J2 throttle regression across adapter boundary)
- ✅ New skill: `async-iterable-adapter-testing` (frozen-Date gotcha + FakeBridge pattern)

**Architecture Status:** ADRs 1–8 locked and implemented. Relay no longer cares whether sessions are SDK-backed or bridge-backed. Composite factory enables both transparently.

**Test Status:** 316 passed, 4 skipped, 0 failed ✅ (296 prior + 20 new bridge tests)

**Known gap (ADR-9 candidate):** bridge sessions silently ignore `permissionCallback` — destructive-tool prompting over the bridge is not yet specced in the wire protocol.

## Architecture — LOCKED + ADR-8 OPERATIONALIZED

**ADRs 1–8 Finalized:**
1. ✅ **ADR-1:** Copilot CLI Extension API for session attach
2. ✅ **ADR-2:** Push-based discovery with `listSessions()` fallback
3. ✅ **ADR-3:** Single named pipe `\\.\pipe\reach-bridge`, JSON-Lines, multiplexed by sessionId
4. ✅ **ADR-4:** Extension crash = session unreachable (no auto-recovery)
5. ✅ **ADR-5:** Daemon runs as logged-in user (not LocalSystem)
6. ✅ **ADR-6:** Extension reconnect = exponential backoff
7. ✅ **ADR-7:** Heartbeat = ping/pong + pipe-teardown detection
8. ✅ **ADR-8:** Canonical Pipe Wire Protocol (streaming, request correlation, self-describing messages)

## Next Steps (Day 5+)

**End-to-End Dogfooding:**
- Install/start daemon as logged-in user; attach a real Copilot CLI session through the extension; drive it from Telegram
- Validate streaming behavior under real network conditions (chunk timing, throttle, splitter against real Copilot output)
- Validate ADR-6 reconnect + ADR-7 heartbeat against a live extension restart

**Production Readiness:**
- Decide on ADR-9 (permission prompting over the bridge — destructive-tool approvals)
- Crash-resilience drills: kill extension mid-stream, kill daemon mid-stream, network hiccups
- Logging and observability for the bridge path

---

## Latest Artifacts

- **Decisions:** `.squad/decisions.md` (Phase 6 ADRs 1–8; Days 3–4 entries pending Scribe merge)
- **Orchestration:** `.squad/orchestration-log/` (Days 3–4 entries pending Scribe)
- **Agent updates:** Kat + Jun `history.md` updated with Days 3–4 recap
- **New skills:** `push-to-pull-async-iterator`, `async-iterable-adapter-testing`

