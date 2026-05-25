# Noble Six — History (Summarized 2026-05-19)

## Identity & Role

- **Agent:** Noble Six (Lead/Architect, Opus 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Architecture, design decisions, protocol reconciliation, ADR documentation
- **Joined:** 2026-04-12

## Current Status

**Phase 6 Day 1 Complete.** All 8 ADRs locked (ADRs 1–7 architectural + ADR-8 protocol reconciliation). Protocol drift reconciled. Day 2 migration tasks assigned.

**2026-05-24 Dogfooding Kickoff:** ADR-10 (pipe auth) finalized and merged into canonical decisions.md. Review 1 dispositions consolidated. Spawned background for dogfooding go-live checklist (Option A from now.md).

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

**2026-05-22 — Protocol v3 uses fire-and-forget notifications for permission requests; there is no CLI-side clock ticking.**  
In Copilot SDK v3, the CLI dispatches `void this._executePermissionAndRespond(...)` — a fire-and-forget broadcast notification. No open JSON-RPC request is held on the CLI side. There is no RPC-level deadline for the daemon to beat. The SDK awaits `handlePendingPermissionRequest` asynchronously after the handler resolves, however long that takes. This is architecturally significant: v2 used `connection.onRequest` (synchronous RPC), which in theory could have a CLI-imposed RPC timeout. v3 eliminated that risk. When verifying SDK timeout behavior, the protocol dispatch pattern (notification vs. synchronous RPC) is the first thing to check.

**2026-05-22 — SDK regression check pattern: grep near the handler call site, not for a constant.**  
The absence of a `permissionTimeout` constant doesn't guarantee absence of a timeout — the timeout could be inlined. The correct check is: `grep -n "setTimeout\|Promise.race\|AbortController" session.js | grep -A2 -B2 "permissionHandler\|executePermissionAndRespond"`. If nothing matches near the handler invocation, no timeout exists. Carter's probe test (`tests/exploratory/sdk-permission-timeout.test.ts`) is the regression harness — run it against new SDK versions to catch any introduced timeout before it reaches production.

**2026-05-22 — No-timeout is architecturally valid for permission prompts; the timeout is a proxy for uncertainty, not a technical requirement.**  
A `permissionCallback` Promise that resolves in 3 days is semantically identical to one that resolves in 3 seconds — the SDK awaits both. During the wait: event loop runs, heartbeat fires, other sessions unaffected. The auto-deny-on-timeout failure mode (wrong decision made without the user) is worse than indefinite wait for async users. One concrete blocker: Copilot SDK's internal `onPermissionRequest` timeout, if any. `setTimeout(fn, Infinity)` fires immediately in Node.js (coercion to 0) — no-timeout requires removing the timer entirely, not passing Infinity. AbortSignal on disconnect (Q3) is mandatory infrastructure for no-timeout mode.

**2026-05-22 — Telegram inline keyboard buttons work indefinitely; the 15-second window is for `answerCallbackQuery` FROM THE TAP, not from message send.**  
A prompt sent Friday is fully functional Monday. Each button tap generates a fresh `callback_query_id`. `answerCallbackQuery` (loading indicator dismissal) has a ~15s window from the tap, but our code wraps it in `.catch(() => {})` anyway. The button routing and `callback_query:data` event are not affected by message age. This means no-timeout works at the Telegram layer with no modifications.

**2026-05-22 — Inline keyboard (A) beats reply keyboard (B) on concurrent-prompt architecture, not implementation cost.**  
Reply keyboard is one keyboard per conversation. N concurrent permission prompts require N independently resolvable affordances — inline keyboard scales trivially (each message has its own buttons + requestId); reply keyboard cannot support this at all. The crash-recovery failure mode (leaked keyboard on process death with no automatic recovery) is a second disqualifier. B has one genuine advantage (overlay visibility regardless of scroll position) that doesn't outweigh these structural problems. When evaluating UX options, check data model compatibility with N-concurrent use cases before evaluating single-prompt ergonomics.

**2026-05-22 — "Allow-always" store should be an injectable interface from day one, even when Phase 6 ships in-memory.**  
The right eventual answer for real users is per-tool-global-persisted (survives daemon restarts). The cost of designing an `AllowAlwaysStore` interface at the start is ~10 extra LOC; the cost of retrofitting it later (after `BridgeSession` has a hardcoded `Set<string>`) is medium. Design for replaceability when you know the upgrade path exists.

**2026-05-22 — Post-timeout behavior determines whether a generous timeout is safe.**  
A clean post-timeout outcome (auto-deny, session continues, Telegram prompt edits in-place, late taps gracefully rejected) means timeout duration is a pure UX tuning knob — there is no "stuck state" risk from a longer timeout. Establish the post-timeout invariants before debating the number. The right timeout (120s) follows from Aaron's actual usage pattern (multitasking, async), not from the default in the existing implementation (60s was set without this knowledge).

**2026-05-22 — `allow-always` scope: per-session in-memory is the right default for solo dogfooding.**  
A `Set<toolName>` on `BridgeSession` instance is the correct Phase 6 default: zero disk I/O, natural expiry on session boundary, upgrade path to persisted (per-tool-global) is medium cost when the user actually asks for it. Do not persist until Aaron explicitly requests it.

**2026-05-22 — Wire protocol should be UX-agnostic; daemon owns UX shape.**  
`permission.request` on the pipe needs only `{toolName, args, permissionId}`. The daemon decides whether to show inline buttons, reply keyboard, or free-text. This means ADR-9's bridge path can reuse `promptUserForPermission()` from `prompt.ts` with zero UX changes — the function already handles correlation, cleanup, and timeout-to-outcome.

**2026-05-22 — `AbortSignal` on `PermissionPrompter.prompt()` should be added before Kat ships BridgeSession.**  
It's a non-breaking optional parameter (~15 LOC across 3 files). Without it, a pending `promptUserForPermission()` stays open in `pendingByRequestId` for up to `timeoutMs` after session disconnect, even if BridgeSession races against it internally. The cost of retrofitting it after the interface is shipped is medium (all callers must update). Add it now.

**2026-05-22 — The timeout discrepancy between ADR-9 (30s) and the existing `prompt.ts` (60s) is a real inconsistency to fix.**  
ADR-9 was drafted with 30s; `promptUserForPermission()` already defaults to 60s. Bridge sessions and SDK sessions sharing a topic should behave identically on timeout. ADR-9 must be amended to `timeoutMs = 60_000` daemon / `65_000` extension before Kat implements. Always check the existing implementation's defaults before proposing new timeout values in an ADR.

**2026-05-22 — Permission prompting is a two-sided async protocol.**  
The extension holds the SDK `permissionCallback` open as a suspended `Promise`; the daemon must resolve it remotely via a request/response pair over the existing pipe. Key insight: the extension's local timeout (e.g., 30s) must be slightly longer than the daemon's user-facing grace period (25s), so `permission.response` always beats the extension's auto-fire. The daemon abort-on-disconnect invariant is critical: any pending `PermissionPrompter.prompt()` must be cancelled when `session.disconnected` fires, or the Telegram prompter can remain open for a dead session indefinitely.

**2026-05-22 — In-stream interleaving is the right pattern for control-plane messages.**  
Interleaving `permission.request`/`permission.response` with `stream` chunks on the same pipe (Alt C) preserves ADR-3's ordering guarantee at the cost of BridgeSession complexity. The ordering guarantee is the deciding factor: `permission.request` for tool N is guaranteed to arrive before stream output from tool N, because the SDK's `permissionCallback` is synchronous-before-execution. A separate pipe (Alt A) loses this guarantee and doubles reconnect complexity.

**2026-05-21 — Triage: extension-side work can leap ahead of the spec.**  
Phase 6 Day 2 triage revealed that `extension.mjs` had already implemented full per-chunk streaming (`handleInject`) — originally spec'd as a stub until Days 3–4. The code was complete, self-contained, and green. Lesson: when a deliverable is "ahead of plan" and passes tests, commit it. The completed extension-side streaming reduced Kat's Days 3–4 scope to relay/daemon-side only, not both sides. **Don't revert work that already passes — triage it and update the plan.**

**2026-05-21 — Adapter > rewrite when the abstraction already fits.**  
Days 3–4 relay integration choice: `relay.ts` was already written against `CopilotSession.send() → AsyncIterable<string>`. The bridge emits `stream` events. A `BridgeSession` adapter (~60 LOC) bridges the gap and inherits 140+ LOC of throttle/edit/fallback logic at zero cost. The principle: when an existing abstraction's shape matches the new integration point, use an adapter before considering a rewrite.

---

## Phase 6 Live Dogfooding Preparation (2026-05-24)

**Date:** 2026-05-24T04:10:11Z  
**Outcome:** Checklist prepared; ready for live phone dogfooding tonight.

**Status before dogfooding:**
- ✅ All 410 tests green (32 test files, 4 skipped)
- ✅ Build succeeds, tsc clean, lint clean
- ✅ Phase 6 merged to main (commit c2c347f), workflows activated
- ✅ ADR-9 hardened against 11 edge cases (eviction, TTY, backpressure, etc.)
- ✅ Named pipe bridge listening, no startup errors

**Critical Findings for Dogfooding:**
1. **No production blockers identified.** Code is ready for end-to-end validation.
2. **ADR-10 (pipe auth) is documented but not yet implemented.** Current code uses randomized pipe name only, no token validation. Not a blocker for solo dogfooding, but marks the pre-production gap.
3. **Inbox has 9 unmerged files** awaiting Scribe (cloud-review findings, reconciliation notes). No new issues surfaced; all are pre-dogfood housekeeping.
4. **Dogfood gate criteria (implicit):** After tonight's end-to-end test, success = permission prompting works over real pipe, no-timeout verified, concurrent prompts don't interfere, safe/destructive tool classification correct in extension.

**Dogfooding Artifacts:**
- `.copilot/reach-dogfood-checklist.md` — 14.7 KB, 250-line checklist with 8 sections:
  1. Pre-flight checks (env vars, Telegram setup, bridge auth)
  2. Build & startup sequence (copy-pasteable commands)
  3. Phone-side validation (chat-ID guard, session lookup, prompt round-trip)
  4. ADR-9 scenarios (6 concrete prompts: safe tool, destructive allow, deny, allow-always, no-timeout, concurrent)
  5. Known gaps & risks (9 inbox items, ADR-10 not yet impl'd, runtime surprises)
  6. Rollback & diagnostics (clean kill, inspect state, hard reset)
  7. Success criteria (8-point validation checklist)
  8. Appendix (command reference)

**Next Session Actions (if dogfooding succeeds):**
1. Append findings to history.md under "## Dogfooding Results"
2. Decide on Phase 7 scope (extend classifier? implement persistent store? ship ADR-10?)
3. Scribe drains 9 inbox files into decisions.md
4. Plan for production readiness (telemetry, monitoring, rollback procedure)

---

## /afk Realignment Analysis (2026-05-24)

**Date:** 2026-05-24T20:12:39-07:00  
**Outcome:** Gap analysis of CLI-initiated `/afk`/`/back` story vs. current Telegram-initiated architecture. Identified 4 missing capabilities, 3 open architectural questions. Recommended pausing Phase 6 tail work to spike ADR-11 and pivot to Phase 7 = `/afk` MVP. Written to `decisions/inbox/noble-six-afk-realignment.md`.

**2026-05-24T22:19-07:00:** Surfaced 16 remaining opens after Aaron's /afk answers — 3 need his call, 1 needs a research spike, 12 have recommendations. Written to `decisions/inbox/noble-six-afk-mode-opens.md`.

**2026-05-24T22:40-07:00:** Drafted ADR-11 (/afk Mode + Multi-Session Mirror Bridge) — 12 sections, 8 new message types, full protocol spec. Written to `decisions/inbox/noble-six-adr11-afk-mode.md`.

**2026-05-24T22:50-07:00:** Amended ADR-11 §3 and §12 Q1 — skill spike resolved: SKILL.md infeasible (prompt-augmentation only), entry point is SDK `commands` field on `JoinSessionConfig` in extension.mjs.

---

## 2026-05-25T06:19:14Z — Phase 7 Orchestration Complete

**Session:** Phase 7 implementation kickoff (Carter-4 + Kat-3 + Jun-1)

**Outcome:** Phase 7 protocol + implementation complete across all three agents. ADR-11 §3–4 decisions locked and validated. Orchestration logs written. Decisions merged to canonical decisions.md.

**Decisions merged:** Carter (pipe types), Kat (mode state), Jun (test cases).

**Status:** All ADR-11 §3–4 protocol decisions locked. Ready for Phase 7 code review + Noble Six validation gate. Decision logs: `.squad/orchestration-log/{2026-05-25T06-19-14Z-carter-4, kat-3, jun-1}.md`.

---

## Archive

Full Phases 1–5 + detailed Phase 6 spike documentation in history-archive.md.
