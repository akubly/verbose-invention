# Noble Six — History (Summarized 2026-06-06 → Phase 1 Complete)

## Identity & Role

- **Agent:** Noble Six (Lead/Architect, Opus 4.6)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** Architecture, design decisions, protocol reconciliation, ADR documentation, SDK drift remediation
- **Joined:** 2026-04-12

## Current Status

**PHASE 2a SHIPPED (2026-06-12, PR#12 squash 56e21ce).** Teams adapter foundation in open repo: optional createThread, conditional config, HTML formatting, promptUser fallback. Closed 21 cloud-review threads. Test suite: 1171 green. Phase 2b gated on Azure AD app registration.

**PHASE 1 COMPLETE + APPROVED + PERSONA REVIEW CYCLE PASSED (2026-06-07).** Channel Abstraction Phase 1 architecture review complete. Verdict: APPROVE-WITH-NITS. F1 blocker (relay capability branching) resolved by Carter in e1f3f4d, verified by Jun in 2b5e4a2. **Two-cycle persona review completed:**
- **Cycle 1 findings:** 3 blocking, 5 important, 4 minor
- **Cycle 2 outcome:** 0 blocking, all 6 prior important findings verified resolved by all Code Panel personas
- **Remediation agents:** Kat (ad05548), Carter (58e1326, 5b6d30c), Jun (823e5d8)
- **Test count:** 937 → 963 (all green, zero regressions). tsc+lint clean.
- **Ship status:** READY FOR /ship-to-pr
- **Deferred to Phase 2:** I4 (optional createThread), I5 (ChannelMessage union), M5 (central mock factory)

Key accomplishments:
- ChannelPort interface design locked (survived implementation unchanged)
- Capability descriptor pattern validated
- coerceId back-compat migration clean (legacy numeric registry.json upgrades transparently)
- Conformance kit (88 tests) + relay tests validate contract compliance
- R1 real regression (paired-config) caught by Jun's regression suite

**Next phase:** Teams adapter development pending corp access.

---

## 2026-06-06 — Channel Abstraction Phase 1 Architecture Review

**Branch:** eature/channel-abstraction (commits: 7b12305, d84dc0c, e69e50b, 3739640)

**Verdict: APPROVE-WITH-NITS.** One blocking finding (F1: relay doesn't check supportsStreaming/supportsMessageEdit capabilities before calling ditMessage during streaming — violates port contract). Five non-blocking nits (N1-N5, deferred to Phase 2/backlog).

**Port is Teams-ready** after F1 fix. The ChannelPort interface itself needs no changes — the bug is in the relay (the consumer), not the port.

Review written to .squad/decisions/inbox/noble-six-phase1-review.md.

---

## 2026-06-06 — F1 Blocker Resolution & Phase 1 Close-Out

**F1 status:** RESOLVED (Carter commit e1f3f4d, verified by Jun commit 2b5e4a2)

**Carter's fix:** Three-case capability branch in relay. Now honors supportsStreaming/supportsMessageEdit flags:
- Case A (Telegram): byte-identical pre-fix behavior
- Case C (Teams streaming disabled): "thinking…" placeholder → single final edit
- Case B (no edit support): single final send, no placeholder

**Jun's verification:** Nine new relay-level capability tests (all pass). Anti-regression test confirms 12 chunks → exactly 1 edit in Case C.

**Final metrics:** 937 → 946 tests green. Zero regressions. tsc clean. lint clean.

**Review verdict update:** APPROVED (F1 blocker resolved). Remaining nits (N1-N5) deferred to Phase 2/backlog.

**Port status:** Teams-ready as written. Relay now correctly implements the capability contract.

Orchestration logs: .squad/orchestration-log/2026-06-06T21-32-33Z-carter.md, .squad/orchestration-log/2026-06-06T21-32-33Z-jun.md.

---

## Key Learnings

### Contract-First Design
The ChannelPort interface I defined in Phase 1 survived Carter/Kat/Jun's implementation unchanged. This validated the design approach.

### Capability Descriptor Pattern
The capability descriptor (supportsStreaming, supportsMessageEdit, etc.) is the right pattern for N transports. The conformance kit validates declared capabilities vs actual implementation behavior.

### Back-Compat Migration
coerceId migration for SessionEntry ID types is clean — legacy numeric registry.json files upgrade transparently to string IDs.

### Relay Contract Compliance
The relay must gate every optional-method call on the corresponding capability flag. This is not the adapter's responsibility — the consumer (relay) owns the contract enforcement.

---

## 2026-06-10 — Phase 2 Teams Adapter Kickoff Plan

**Status:** DRAFT plan written to `.squad/decisions/inbox/noble-six-phase2-teams-kickoff.md`, pending Aaron's approval.

**Key planning conclusions:**

1. **Capabilities:** Recommended `supportsMessageEdit=false` for v1 (rate-limit risk outweighs benefit when streaming is already disabled), `supportsInteractivePrompts=false` (text-fallback; Adaptive Cards deferred), `supportsThreadCreation=false`, `supportsStreaming=false`. maxMessageLength=28,000.

2. **I4/I5 disposition:** Recommended I4 (optional createThread) as a refactor-first in the open repo — small PR, prevents boilerplate throwing method in Teams adapter. I5 (ChannelMessage union for Adaptive Cards) deferred — no concrete use case yet, risk of premature abstraction.

3. **Polling design:** Delta query preferred over list+filter. 3-second poll interval balances UX latency vs rate budget (~0.33 req/sec polling, ~1.67 req/sec outbound).

4. **Corp-fork strategy:** Minimal diff — only `src/channel/teams/`, env config block, one import line in main.ts. Rebase on main. I4 and env config land in open repo first to minimize divergence.

5. **Work split:** Phase 2a (open repo, no corp access) vs Phase 2b (corp fork). Carter owns adapter/relay/polling/config, Kat owns formatting/UX, Jun owns conformance/integration, Noble Six owns I4 contract change + ADR, corp-side owns app registration/secrets/validation.

6. **8 open decisions flagged for Aaron** including supportsMessageEdit, poll interval, I4 sequencing, Adaptive Cards vs HTML, secret storage, test team target, AFK mode scope, pairing flow.

## 2026-06-10 — P2a-1 (I4): Optional createThread Refactor

**Branch:** `user/aaron/phase2a` (commit: 71054e7)

**Mechanism chosen: TypeScript optional method (`createThread?`).**

Rationale: idiomatic TS, zero runtime overhead, no discriminated union needed, and the existing capability flag (`supportsThreadCreation`) already serves as the semantic gate. A caller that respects both the flag and method presence gets the full guard.

**Caller-guard pattern** (documented in port.ts TSDoc, for Carter/Jun to follow exactly):
```typescript
if (!channel.capabilities.supportsThreadCreation || !channel.createThread) {
  throw new Error(`[caller] createThread not supported by ${channel.name}`);
}
const ctx = await channel.createThread(channelId, title);
```

**Files touched:**
- `src/channel/port.ts` — `createThread?` (optional method), updated TSDoc with caller-guard example
- `tests/channel/conformance/runner.ts` — section 6 conformance tests updated:
  - `supportsThreadCreation=true`: asserts method is present on real adapter AND returns valid ChannelContext
  - `supportsThreadCreation=false`: kit does NOT call createThread; asserts capability flag only
  - Fallback matrix: added "method absent" test showing caller-guard pattern; clarified FakeChannel's throw is one valid implementation (absence is equally valid)

**Unchanged:** `src/channel/telegram/index.ts` (still implements `createThread`; behavior byte-identical), `tests/channel/conformance/FakeChannel.ts` (still implements `createThread` and throws when `supportsThreadCreation=false`).

**No production callers to update:** `afkMode.ts` calls `this.bot.api.createForumTopic()` directly; the relay never calls `createThread`. This is by design — AFK mode is Telegram-specific and bypasses the port.

**Test delta:** 1002 passing (+2 net new tests). tsc + lint clean.

**Downstream notes for Carter (P2a-3):** TeamsChannel must declare `supportsThreadCreation: false` and may simply omit the `createThread` method entirely — no boilerplate throwing method required.

**Downstream notes for Jun (P2a-6):** The Teams conformance test will get the `supportsThreadCreation=false` path in the runner, which verifies capability=false and does NOT call createThread.

---

## Learnings

### Phase 2 Planning: Contract Changes Gate the Fork
I4/I5 are open-repo changes to the shipped ChannelPort contract. Doing I4 first (before the corp fork branches) prevents rebase conflicts on port.ts. I5 can safely defer because the v1 adapter doesn't need structured payloads.

### Rate-Limit Budget Is a Shared Resource
Graph API rate limits are per-app, not per-endpoint. The polling loop and outbound sends share the same budget. This means capability decisions (supportsMessageEdit, supportsStreaming) have rate-budget implications — not just UX implications.

### Corp-Fork Diff Discipline
The fewer files the corp branch touches in shared code, the cleaner rebases are. Landing env config and contract refactors in the open repo first means the corp branch only adds new files (src/channel/teams/*) plus one import line.

### canCreateThread Type Guard (Phase 2a review cycle 1, 2026-06-11)
Added exported helper to port.ts that centralizes the dual-check callers need before invoking `createThread?`. Canonical signature:
```typescript
export function canCreateThread(
  channel: ChannelPort,
): channel is ChannelPort & { createThread: NonNullable<ChannelPort['createThread']> } {
  return channel.capabilities.supportsThreadCreation && typeof channel.createThread === 'function';
}
```
`createThread?` stays optional (OD-3 preserved). The TSDoc on `createThread?` now points at this guard instead of documenting a hand-written pattern.

### promptUser Text-Fallback Contract Codified (Phase 2a review cycle 1, 2026-06-11)
The LOCKED matching contract is now authoritative in port.ts TSDoc: text-fallback adapters match replies (trimmed, case-insensitive) against `PromptOption.value` OR a 1-based index string; replies matching neither are SILENTLY IGNORED (not forwarded to the message handler) while a prompt is pending. Future adapter authors and FakeChannel have a single source of truth.

---

## Archive

Earlier phases (1–9), orchestration details, and detailed learnings from Phase 7–9 work archived in history-archive.md (40.4 KB).
