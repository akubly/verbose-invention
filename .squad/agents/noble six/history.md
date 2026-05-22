# Noble Six — History (Summarized 2026-05-19)

## Identity & Role

- **Agent:** Noble Six (Lead/Architect, Opus 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Architecture, design decisions, protocol reconciliation, ADR documentation
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Day 1 Complete.** All 8 ADRs locked (ADRs 1–7 architectural + ADR-8 protocol reconciliation). Protocol drift reconciled. Day 2 migration tasks assigned.

---

## Recent Context

### Phase 6 Architecture Decision (2026-05-09 to 2026-05-19)

**Spike Outcome (2026-05-09):**
Aaron chose Option B (extension-bridge) for Phase 6 MVP. This circumvents the port-discovery gap by using the Copilot CLI extension API (@github/copilot-sdk/extension) for push-based session registration over a named pipe.

**ADRs 1–7 Finalized (2026-05-19T22:13:42Z):**
- **ADR-1:** Copilot CLI Extension API for session attach (push-based registration, no port discovery)
- **ADR-2:** Push-based discovery with listSessions() fallback
- **ADR-3:** Single named pipe \\.\pipe\reach-bridge, JSON-Lines, multiplexed by sessionId
- **ADR-4:** Extension crash = session unreachable (no auto-recovery)
- **ADR-5:** Daemon runs as logged-in user (fixes LookupAccountName bug)
- **ADR-6:** Extension reconnect = exponential backoff
- **ADR-7:** Heartbeat = ping/pong (30s/5s/15s) + pipe-teardown detection

**Key Insight:** Aaron's single-user scope decision simplified three architectural problems into one: pipe security, session scoping, and install.ts bug all collapse when daemon runs as logged-in user.

### Phase 6 Day 1 Implementation (2026-05-19)

**Parallel Task Delivery:**
- **Carter:** src/bridge/extensionBridge.ts (pipe server), xtension.mjs (skeleton) — both compile, tests green
- **Jun:** 	ests/helpers/FakeDaemon.ts, FakeExtensionClient.ts, 15-test smoke suite — all green
- **Kat:** src/service/install.ts refactored to user-account install per ADR-5 — all 22 install tests green
- **Full test suite:** 296 passed, 4 skipped, 0 failed ✅

**Protocol Drift & ADR-8 Reconciliation:**
Carter and Jun independently designed different message protocols (both valid per ADR-3 framing spec). ADR-8 systematically reconciles:
- **Decision:** Adopt Jun's streaming schema as canonical (inject/stream/equestId/chunk/done)
- **Rationale:** 
  1. Preserves Phase 5 streaming UX (Telegram placeholder real-time edits at 800ms intervals)
  2. equestId correlation is critical for daemon-relay message routing
  3. Terminology consistency (Jun's hello aligns with ADR-2/ADR-6)
  4. Forward compatibility (retaining session.event for future event types)
- **Consequences:** Carter Day 2 migration (~8 changes), Jun Day 2 addition (1 type), both pass full test suite

---

## Key Design Principles

1. **Early reconciliation beats late refactor.** Detecting and resolving protocol drift on Day 1 is cheaper than discovering incompatibilities after the relay refactor depends on three code paths.

2. **Systematic comparison over gut calls.** Each of the 6 protocol divergences was analyzed independently (edge cases, performance impact, UX consequences, forward compatibility). The decision wasn't "streaming is better" — it was "streaming is required for Phase 5 UX AND request correlation AND self-describing messages AND forward compatibility."

3. **Constrain scope to simplify architecture.** Single-user scope (Aaron's decision) eliminated the need for cross-integrity-level pipe security tricks, multi-user session isolation, and install.ts account resolution complexity.

---

## Next Steps (Day 2+)

**Day 2:** Carter migration (~8 changes, ~2 hours) + Jun addition (1 change, ~15 min) + full test suite green

**Days 3–4:** Relay integration — ridge.on('stream', ...) feeds Telegram placeholder edits, equestId correlation for in-flight responses, 800ms throttle window applied unchanged

**Day 5+:** End-to-end testing, dogfooding, production readiness

---

---

## Phase 6 Day 2 (2026-05-20)

**Status:** ADR-8 operationalization complete. Protocol migration validated.

**Outcomes:**
- ✅ **Carter:** 8 mechanical migration changes (extensionBridge.ts + extension.mjs) → ADR-8 canonical schema
- ✅ **Jun:** SessionEventMessage type added to InboundMessage union (forward-compat)
- ✅ **Verification:** 296 passed / 4 skipped / 0 failed | tsc + lint clean
- ✅ **Decision records:** 2 inbox entries (sendCommand API, session.event shape) merged into decisions.md
- ✅ **Archive:** Old decisions (>7 days) purged from decisions.md; baseline preserved

**Key Insight:** Day 1 protocol reconciliation (ADR-8) proves out on Day 2 with zero regressions. All bridges now speak canonical schema. Ready for relay integration (Days 3–4).

---

## Learnings

**2026-05-21 — Triage: extension-side work can leap ahead of the spec.**  
Phase 6 Day 2 triage revealed that `extension.mjs` had already implemented full per-chunk streaming (`handleInject`) — originally spec'd as a stub until Days 3–4. The code was complete, self-contained, and green. Lesson: when a deliverable is "ahead of plan" and passes tests, commit it. The completed extension-side streaming reduced Kat's Days 3–4 scope to relay/daemon-side only, not both sides. **Don't revert work that already passes — triage it and update the plan.**

**2026-05-21 — Adapter > rewrite when the abstraction already fits.**  
Days 3–4 relay integration choice: `relay.ts` was already written against `CopilotSession.send() → AsyncIterable<string>`. The bridge emits `stream` events. A `BridgeSession` adapter (~60 LOC) bridges the gap and inherits 140+ LOC of throttle/edit/fallback logic at zero cost. The principle: when an existing abstraction's shape matches the new integration point, use an adapter before considering a rewrite.

---

## Archive

Full Phases 1–5 + detailed Phase 6 spike documentation in history-archive.md.
