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

---

## Archive

Full Phases 1–5 + detailed Phase 6 spike documentation in history-archive.md.

Full Phases 1–5 + detailed Phase 6 spike documentation in history-archive.md.

