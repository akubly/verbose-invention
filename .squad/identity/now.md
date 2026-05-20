---
updated_at: 2026-05-19T21:49:56Z
focus_area: Phase 6 — Extension-bridge architecture adopted, team impact assessed, awaiting Aaron's Option A vs B decision
active_issues: [Aaron Option A vs B call on Phase 6 scope, Noble Six 3 architectural blockers (pipe security, reconnect spec, heartbeat)]
---

# What We're Focused On

**Phase 6: Session 0 Control Plane + Extension-Bridge Data Plane**

Phases 1–5 shipped. Aaron dogfooding Reach. Phase 6 design evolved post-spike.

**Team sync complete (2026-05-19):**
- **Noble Six revised proposal:** Extension-bridge locked as Phase 6 MVP architecture (not stretch item). Replaces original port-discovery uncertainty. Locked decisions 6–10, ADRs 1–4.
- **Kat bot-side impact:** `/list` cleaner (direct map read), `/attach` now implementable, `/kill` dual-path needed. 4 new failure modes defined. Effort ~wash (+0.5 days).
- **Jun test impact:** Scope grows ~93% (3.5→6.75 days). 10 new edge cases. Named pipe contract schema required before implementation. EC-08 (extension crashes CLI when daemon absent) highest-risk.

**What's adopted:**
- Extension-bridge replaces `/attach` uncertainty with concrete architecture: named pipe server (`\\.\pipe\reach-bridge`), JSON-Lines protocol, extension lifecycle = CLI lifecycle.
- Carter builds `extensionBridge.ts` + `extension.mjs` + relay refactor (Days 1–5).
- Kat builds `session0.ts` + routing + `/attach` handler + install step (Days 3–5).
- Jun writes contract + integration tests + Windows CI matrix (Days 1–5).

**Aaron's decision gate (UNCHANGED):**

Choose option for Phase 6 MVP:

1. **Option A (Original)** — Ship `/list` + `/new` only (no extension, lower risk)
2. **Option B (Adopted by team)** — Ship `/list` + `/new` + `/attach` via extension bridge (full bidirectional, ~2 day add-on, medium risk)

**Current status:** Noble Six recommends Option B (based on Aaron's 80%+ resume-existing usage pattern). **Awaiting Aaron's final decision before implementation kicks off.**

**Blockers to resolve (Noble Six → Aaron):**
1. **Pipe security across integrity levels** — Can elevated CLI connect to LocalSystem daemon pipe? DACL strategy?
2. **Extension reconnect policy** — Does `extension.mjs` reconnect after daemon restart? Retry policy?
3. **Heartbeat design** — Ping/pong in protocol, or rely on pipe teardown events? Affects EC-03 timing.

**Latest artifacts:**
- Decisions merged: `.squad/decisions.md` (Phase 6 Revised, Kat Phase 6 Bot-Side Impact, Jun Phase 6 Test Impact)
- Orchestration: `.squad/orchestration-log/2026-05-19-phase6-sync.md`
- Session: `.squad/log/2026-05-19-phase6-extension-bridge-review.md`
- Carter history updated: `.squad/agents/carter/history.md` (Phase 6 Extension-Bridge Adoption)

**Scoping:** `.squad/decisions.md`

