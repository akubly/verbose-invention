# Noble Six — History (Summarized 2026-05-28 → Phase 8.5 complete 2026-05-30)

## Identity & Role

- **Agent:** Noble Six (Lead/Architect, Opus 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Architecture, design decisions, protocol reconciliation, ADR documentation, **SDK drift remediation** (Phase 8.5 Issue #8)
- **Joined:** 2026-04-12

## Current Status

**Phase 8.5 COMPLETE.** Issue #8 (SDK API drift in mirror.input) fixed 2026-05-30. Replaced `for await` with event-emitter streaming pattern. 4 regression guards added. Issue #9 (Telegram echo) likely resolved (cascade). 570 tests green.

**Phase 8 COMPLETE (P1 + watch sweep).** All deliverables merged into decisions.md. F4 soft refactor (stream routing extraction) and A6-6 fleet validation both complete. Remaining P2 watches dormant per Cycle 7 triage. Code stable and ready for ship-to-pr or next sprint.

**Test baseline:** 570 passed / 4 skipped / 0 failed. tsc clean, lint zero warnings (was 517, now +33+4 new).

**ADR Status:** All 11 ADRs locked and validated (ADR-1 through ADR-11). No drift detected.

---

## Phases 1–6 Summary

Full Phase 1–6 documentation archived in history-archive.md. Key accomplishments:

**Phase 1-5:** Architecture spike, protocol design, spike outcomes for extension-bridge choice (Option B).  
**Phase 6:** Bridge implementation (extensionBridge.ts, extension.mjs), protocol migration to ADR-8, permission prompting investigation, /afk realignment analysis, ADR-11 specification.

---

## 2026-05-25T06:19:14Z — Phase 7 Orchestration Complete

**Session:** Phase 7 implementation kickoff (Carter-4 + Kat-3 + Jun-1)

**Outcome:** Phase 7 protocol + implementation complete across all three agents. ADR-11 §3–4 decisions locked and validated. Orchestration logs written. Decisions merged to canonical decisions.md.

**Decisions merged:** Carter (pipe types), Kat (mode state), Jun (test cases).

**Status:** All ADR-11 §3–4 protocol decisions locked. Ready for Phase 7 code review + Noble Six validation gate. Decision logs: `.squad/orchestration-log/{2026-05-25T06-19-14Z-carter-4, kat-3, jun-1}.md`.

---

---

## 2026-05-27T23:48:20Z — Phase 8 P1 Sprint SHIPPED

**Session:** Phase 8 P1 sprint completion (Kat, Carter, Jun, Scribe)

**Outcome:** Four backlog items closed (A7, A8, N2, N3). Zero ADR drift detected. All tests green. Phase 8 P1 ready for Noble Six review and ship-to-pr.

**Deliverables:**
- **A7 (Carter):** Inbound message shape drift coverage — 30 new assertions, all interfaces verified against ADR specs, no drift found
- **A8 (Jun):** Composition-root integration harness — 7 tests for main() branches, mocked all external boundaries, A8 REOPENED gate CLOSED
- **N2 (Kat):** Deny-all configuration guard — production guard + unit test, `allowedUserIds: Set([])` now fatal exit
- **N3 (Jun):** Config-layer end-to-end — 2 integration tests verify config → AfkModeController wiring

**Test baseline:** 515 passed / 4 skipped / 0 failed. tsc clean, lint zero warnings.

**Next:** Await Noble Six review. Once approved, ship-to-pr will create final PR for merge.

**Records:** Orchestration logs, session log, Phase 8 section merged into decisions.md.

---

## 2026-05-28T17:00:30Z — Phase 8 Watch Sweep COMPLETE

**Session:** Phase 8 post-P1 watch audit and disposition decisions

**Outcome:** F4 watch FIRED and resolved via Kat's soft refactor; A6-6 watch closed by Jun's fleet validation; remaining watches (A2, F8, F5, A10-4) dormant per Cycle 7 triage. Phase 8 effectively complete (P1 + watch sweep done).

**Deliverables:**
- **F4 (Kat):** Extracted `src/bot/afkStreamRouter.ts` (133 LOC); `afkMode.ts` now 649 LOC (down from 733). Mirror rate limiter identified as next extractable subsystem (not acted on; file comfortably under threshold).
- **A6-6 (Jun):** Fleet compensation burst validated at N=20 with/without 429 retries. Parallel `Promise.all` close is safe; timeout cap bounds wall time. No extraction needed yet.
- **Audit (Jun explore):** All watch conditions audited; F4 FIRED (LOC), A6-6 resolved; A2/F8/F5/A10-4 dormant.

**Test baseline:** 517 passed / 4 skipped / 0 failed (fleet test added). All code changes validated (tsc clean, lint zero warnings).

**Records:** Decisions.md updated with Phase 8 watch summary; orchestration logs for Kat/Jun; session log for watch sweep.

**Architect notes:** Mirror rate limiter design note flagged for Noble Six review at next architecture pass (kat-afkmode-refactor-insights.md, merged into decisions.md).

---

## 2026-05-29T21:53:17Z — Dogfooding Plan Phase 8 Drafted

**Session:** Dogfooding plan synthesis (Noble Six architect)

**Outcome:** Comprehensive dogfooding plan drafted and ready for Aaron's execution. Plan built on Phase 6 checklist foundation, incorporating Phase 7 AFK/mode decisions (ADR-11) and Phase 8 hardening (P1 + watch sweep).

**Deliverable:** `.copilot/reach-dogfood-plan-phase8.md` (16 KB, 340 lines)

**Plan structure:**
- **Preflight** (1.1–1.3): Env setup, build, smoke test — reuses Phase 6 checks with Phase 8 updates
- **Scenario matrix** (4 groups, 16 scenarios):
  - A: Permission prompting (5 scenarios — edge cases from ADR-9)
  - B: AFK mode (6 scenarios — ADR-11 round-trip)
  - C: Stream routing (6 scenarios — F4 refactor + Cycle 3 fixes: truncation, empty placeholder, mid-deactivation races, fleet load)
  - D: Config guard (2 scenarios — N2 deny-all protection)
- **Known gaps** (deferred items + dormant watches)
- **Triage protocol** (critical/high/medium handling)
- **Success criteria** (preflight green, ≥80% scenarios, zero critical)

**Key risks called out for Phase 8 validation:**
1. Permission prompting timeout edge case (A5) — validates no-timeout guarantee from ADR-9
2. Stream truncation at 4096 chars (C2) — Phase 8 Cycle 3 fix
3. Empty chunk placeholder (C3) — Phase 8 Cycle 3 edge case
4. Mid-stream deactivation race (C5) — error frame leak risk during `/back`
5. Fleet compensation at N=20 (C6) — live validation of A6-6 verdict (test lab only; real-world confirmation)
6. Config guard fatal path (D1–D2) — N2 production guard + message clarity

**Architectural decisions captured for Phase 9:**
- Mirror rate limiter identified as next extractable subsystem (when `afkMode.ts` approaches 700 LOC or logic gains complexity)
- ADR-10 (pipe token validation) remains pre-production gap — noted as not blocking Phase 8 dogfooding on solo machine

**Test baseline:** 517 passed / 4 skipped / 0 failed. All Phase 8 code validated. Plan assumes production-ready codebase.

**Next:** Aaron executes plan (45–90 min). Issues filed to `squad` label. Noble Six reviews findings post-dogfood.

---

## 2026-05-29T22:22:08Z — Install Story Handoff Drafted

**Session:** Install gap design (Noble Six architect, solo)

**Trigger:** Aaron tried `/afk` during dogfood prep; extension not installed. Carter's audit confirmed the gap: daemon has `npm run service:install`; extension has no install path at all.

**Outcome:** Install story designed and handed off. Recommendation = **Option C** (single `npm run install` orchestrator). Handoff document written at `.copilot/reach-install-handoff.md`.

**Decision:** Option C — one `npm run install` command orchestrating service install + extension copy + config wizard. Cross-platform deferred (Windows-only). Copy-on-install for extension (not symlink). Extension copy is Task 1 (Carter) — immediate unblock for dogfooding.

**Phase call:** Phase 8.5 micro-sprint. Four tasks. One session. Unblocks Phase 9 by ensuring dogfood is actually runnable.

**Team inbox:** `.squad/decisions/inbox/noble-six-install-story.md`

---

## 2026-05-29T23:23:03-07:00 — Issue #8 Fix: mirror.input SDK API Drift

**Session:** Phase 8.5 critical blocker resolution (Noble Six architect, solo)

**Trigger:** Aaron's `/afk` integration test crashed during dogfood prep. Every Telegram→CLI message failed with `sdkSession.send(...) is not a function or its return value is not async iterable`.

**Root Cause:** `extension.mjs:streamSdkResponse` used `for await (const chunk of sdkSession.send(text))`, expecting an async iterable. SDK v0.2.2 changed `send()` to return `Promise<string>` (a message ID). The daemon side (`src/copilot/impl.ts / CopilotSessionAdapter`) had already been adapted to v0.2.2's event-emitter pattern; the extension was not updated at the same time.

**Fix:** Replaced the `for await` loop with the event-emitter streaming pattern (matching `impl.ts`):
- `session.on('assistant.message_delta', ...)` for chunks
- `session.on('session.idle', ...)` for completion
- `sdkSession.send({ prompt: text })` as fire-and-forget
- 5-minute timeout + `settled` guard to prevent double-resolve

**Files changed:**
- `extension.mjs` — `streamSdkResponse` function rewritten
- `tests/bridge/extension-protocol-drift.test.ts` — 4 new regression assertions
- `.squad/decisions/inbox/noble-six-issue8-mirror-input-fix.md` — ADR-style record

**Test baseline:** 546 passed / 4 skipped / 0 failed (was 517; new tests from Phase 8.5 sprint).

**Issue #9 (double echo):** Probable resolution — the echo stemmed from mirror.input never reaching the model. Marked for re-verification in dogfood.

**Architectural note:** Two places hold raw SDK sessions (daemon + extension). The daemon is type-protected via `CopilotSession` interface; extension is plain JS. Flagged for Phase 9: extract a shared streaming adapter to reduce future drift surface.

---

## 2026-05-30T11:32:20Z — Phase 9 Triage Complete

**Session:** Phase 9 dogfood feedback triage (Noble Six architect, solo)

**Trigger:** Aaron brought 3 feedback items from Phase 8.5 dogfood. Noble Six tasked with triage + design.

**Deliverable:** `.copilot/reach-phase9-design.md` (21 KB design doc)

### Three Items Triaged

| Item | Problem | Recommendation | Complexity |
|------|---------|----------------|------------|
| 1 | No orientation message on topic activation | Send session status (sessionId, cwd, model, mode) on first activation per-session | S |
| 2 | Slash commands don't pass through from Telegram | **Path B (pass-through)** — `isBotCommand()` guard that allows CLI commands through | M |
| 3 | No way to start sessions in different cwds | Extend config.json with `knownCwds`, add `/cwd` commands, extend `/new --cwd` | M-L |

### Key Investigation Findings

1. **Item 2 root cause:** `afkMode.ts:151` explicitly drops all `/` prefixed messages. This was a blanket guard to avoid intercepting Telegram bot commands. Recommendation: distinguish bot commands (`/new`, `/list`, etc.) from CLI commands (`/clear`, `/agent`, `/model`) via `isBotCommand()` helper.

2. **`relay.command` envelope is stubbed:** The protocol supports structured command dispatch (`relay.command` message type), but the daemon has no producer and the extension handler is a no-op. Phase 9 recommends `mirror.input` pass-through; `relay.command` deferred to Phase 10+ for curated command UX.

3. **Session cwd is descriptive, not prescriptive:** Registry stores cwd for informational purposes. Spawn-from-Telegram (daemon choosing where to start CLI) is Phase 11+ scope.

### Sprint Decomposition

9 tasks across 3 parallel tracks:
- Track 1 (Item 1+2): Kat + Carter + Jun — S+M tasks
- Track 2 (Item 3): Kat + Carter + Jun — M-L tasks
- Track 3 (Docs): Scribe

Estimated total: ~20–25h team-wide, 1–2 sessions.

### Open Questions for Aaron

8 questions documented in design doc §6. All have sensible defaults if Aaron doesn't weigh in.

**Team inbox:** `.squad/decisions/inbox/noble-six-phase9-triage.md`

---
# Noble Six — History

## Identity & Role

- **Agent:** Noble Six (Lead / Architect, Opus 4.5)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Architectural triage, design feasibility, phase planning, decision consolidation
- **Joined:** 2026-05-30 (Phase 9 triage)

## Current Status

**Phase 9 TRIAGE COMPLETE.** Conducted feasibility assessment on 3 Aaron dogfood feedback items (2026-05-30T11:32:20). All items confirmed feasible and scoped for 3-item sprint. Recommended BOT_COMMANDS centralization and pass-through via mirror.input. Findings filed to decisions.md.

---

## Phase 9 Sprint — 2026-05-30

**Role:** Architectural lead for phase 9 dogfood resolution.

### Triage Work (2026-05-30T11:32)

Investigated 3 Aaron feedback items from Phase 8.5 re-verification:

1. **Orientation message + /status command** — AFK mode enhancement
   - **Finding:** Feasible, low complexity. Recommend in-memory gate + daemon excerpt caching.
   - **Decision:** 500-char truncation, plain text format.

2. **Slash command pass-through** — CLI commands relayed via Telegram
   - **Finding:** Guards currently overbroad (`/` prefix check blocks all slashes). Recommend isBotCommand() gate.
   - **Discovery:** relay.command protocol stubbed; mirror.input sufficient for Phase 9.
   - **Recommendation:** Centralize BOT_COMMANDS set to avoid desync.

3. **CWD registry** — Multi-session launch point management
   - **Finding:** CWD field is descriptive (not prescriptive). No Telegram spawn yet (Phase 11+ scope). Feasible for registry + selection.
   - **Discovery:** Session CWD defaults to process.cwd() already. No spawn implementation needed.

### Key Recommendations to Team

- **BOT_COMMANDS centralization** → `src/bot/commands.ts` (peer module, Carter implemented)
- **Pass-through via mirror.input** (not relay.command) ✅ Implemented by Carter
- **Scope alignment** → 3-item sprint executed

### Outcome

Provided architectural direction for phase 9 3-item sprint. All recommendations adopted and shipped by Kat, Carter, Jun.

---

### Phase 9 Review Note (2026-05-30)

**Persona review complete on branch user/aaron/phase9.** Two cycles, 7+4 personas. 783 tests passing. All 14 important + 3 blocking (1 deferred) + 20 minor findings addressed. Streaming serialization design (Option A) implemented by Carter; all architecture recommendations verified. Ready for Aaron to PR/merge. Phase 10 backlog: live /status, cross-platform paths, auto-capture, env hardening, parser polish.

---

## Knowledge Base

### Architectural Patterns (Phase 9)

- **Guard Design:** isBotCommand() pattern for command filtering (case-insensitive, @botname handling via regex)
- **Protocol Preservation:** Pass-through via mirror.input maintains protocol contracts (no mode.changed without back.request round-trip)
- **Centralized Sets:** Command lists as single source of truth in peer module (prevents desync)
- **CWD Strategy:** Registry-first, spawn deferred to later phase

### Decision Consolidation

All 8 agent decision files reviewed and merged to `.squad/decisions.md`:
- Noble Six triage findings
- Kat Item 1 (orientation), Item 3 T5 (config schema)
- Carter Item 2 (pass-through), Item 3 T6/T7 (commands + flag)
- Jun Item 2 tests, Item 3 tests

### No Further Phases Assigned

Noble Six's triage work complete. Ready for follow-up architectural work if Phase 10 needs lead planning.

---

## 2026-05-31T22:50:00-07:00 — State Storage Unification Design (PR #10 Cycle 3)

**Context:** Copilot review surfaced 4-finding cluster (T1/T3/T4/T5) about split state storage — config+registry in `%APPDATA%\reach\`, bridge-auth in `%LOCALAPPDATA%\reach\`.

### Investigation Findings

1. **Split was unintentional** — two authors picked two different Windows roots with no coordinating ADR.
2. **APPDATA for config was NOT intentional roaming** — knownCwds contains local filesystem paths that would break on roaming. Reach is a single-machine daemon.
3. **LOCALAPPDATA for bridge-auth WAS intentional** — ADR-10 says "per-run, regenerated every start." But the right fix is unified root, not LOCALAPPDATA as the root.
4. **README was wrong** — claimed all state in `%LOCALAPPDATA%\reach\` when config+registry are actually in `%APPDATA%\reach\`.
5. **`--wipe` was incomplete** — only wiped `%LOCALAPPDATA%\reach\`, leaving config+registry orphaned in `%APPDATA%\reach\`.

### Recommendation

**Option D — `~/.reach/` (`os.homedir()/.reach/`).** Single root, zero platform switches, cross-platform ready. Matches CLI tool convention (`~/.aws/`, `~/.kube/`). Service (ADR-5) runs as logged-in user so `os.homedir()` resolves correctly.

**Rejected Option B** (unify under `%APPDATA%`) as actively harmful — roaming bridge-auth would break multi-machine profiles.

### Deliverables

- Design doc: `.copilot/reach-state-storage-design.md`
- Decision inbox: `.squad/decisions/inbox/noble-six-state-storage-triage.md`

### Learning

- When two modules independently pick a state root, the mismatch is invisible until someone audits all write paths. Future ADR practice: any new persistent file gets a one-line "storage root" note in the PR description.

---


## Learnings

### Slash Command Pass-Through Pattern

When bridging between messaging platforms (Telegram) and CLI tools, blanket `/` guards to avoid bot command collision are too broad. Better pattern:
1. Enumerate known bot commands explicitly (`BOT_COMMANDS` set)
2. Only intercept messages matching that set
3. Pass through everything else (including CLI slash commands like `/clear`, `/model`)

This preserves CLI command parity while still letting the bot handle its own commands.

### Protocol Envelope Reservation

The `relay.command` pattern shows good forward thinking: reserve the protocol envelope even if implementation is deferred. This allows structured command dispatch later without protocol changes. The stub in `extension.mjs` serves as documentation + placeholder.

### CWD as Descriptive vs. Prescriptive

Important distinction for daemon-to-CLI bridges:
- **Descriptive cwd:** Record where CLI was started (passive, informational)
- **Prescriptive cwd:** Control where CLI starts (active, requires process spawn)

Phase 9's cwd registry is descriptive + selection UX. Prescriptive spawn is a different feature (Telegram-initiated sessions), correctly deferred.

## 2026-05-30T22:08:00-07:00 — Phase 9 Streaming Fix Design (I1 + I2)

**Session:** Phase 9 review follow-up — streaming architecture fix design

**Trigger:** Phase 9 code review surfaced two architecturally-coupled streaming concerns in `extension.mjs:streamSdkResponse`:
- **I1 (Backpressure):** `pipeSocket.write()` fire-and-forget, no drain handling
- **I2 (Cross-wiring):** Concurrent `mirror.input` calls register duplicate listeners on shared `sdkSession`; chunks and idle signals cross between requests

**Investigation findings:**
1. SDK `assistant.message_delta` carries `data.messageId` (correlatable to `send()` return value), but `session.idle` has **no correlation field** — only `data.aborted?: boolean`. Pure messageId correlation is therefore insufficient for completion detection.
2. Daemon-side `CopilotSessionAdapter` (impl.ts:109–123) already uses a serialization queue (`sendQueue`) — proven pattern.
3. Extension-side `handleMirrorInput` is `async` but called from synchronous pipe dispatch — `await` does NOT prevent concurrent calls.
4. Rate limiting (20 msg/min) is a throughput cap, not a serialization gate. Two messages 1s apart → concurrent streams.

**Decisions:**
- **A (Correlation):** Serialization queue — mirrors daemon pattern. `session.idle` having no messageId makes concurrent correlation infeasible.
- **B (Backpressure):** Drain-aware writes — check `write()` return, await `drain` event. Defense-in-depth for local IPC pipe.
- **C (Listener lifecycle):** Current cleanup is correct (unsub functions called in `cleanup()`). No structural change needed.
- **D (Error handling):** `send()` return value (messageId) not needed under serialization. Current fire-and-forget + `.catch()` is correct.

**Concurrency verdict:** REAL but low-probability. No serialization gate exists between pipe message dispatch and `streamSdkResponse()`.

**Deliverable:** `.copilot/reach-phase9-streaming-fix-design.md`

---

## Learnings

### SDK Event Correlation Asymmetry

`assistant.message_delta` carries `data.messageId` (correlatable to `send()` return), but `session.idle` has NO correlation field. This asymmetry means you can filter deltas by message but cannot determine which send() triggered idle. Serialization is the only correct approach when both delta routing and completion detection matter.

### Serialization Queue as Cross-Layer Pattern

Both daemon (`CopilotSessionAdapter.sendQueue`) and extension need the same pattern. When two code paths talk to the same SDK session, the serialization must happen at each entry point independently — the SDK itself processes serially but doesn't enforce serial submission.

---

## Archive

Full Phases 1–5 + detailed Phase 6 spike documentation in history-archive.md.

Full Phases 1–5 + detailed Phase 6 spike documentation in history-archive.md.

