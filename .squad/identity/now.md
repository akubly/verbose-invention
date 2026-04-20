---
updated_at: 2026-04-20T09:40:00Z
focus_area: Phase 3 — Complete Feature Set
active_issues: []
---

# What We're Focused On

**Phase 3: Complete Feature Set**

PR #2 (Phase 2 Go Live) merged. Phase 3 combines all remaining work.

**Completed (Wave 1):**
- README.md & setup guide — Kat ✅
- Per-session model override (`/new <name> --model <model>`) — Noble Six + Carter + Kat ✅
- Per-session model tests (13 new, 107 total) — Jun ✅
- Architecture designs for P1/P2 features — Noble Six ✅

**Ready for implementation (pending Aaron's review):**
- SDK crash auto-recovery (P1) — error-triggered restart with backoff (~40 LOC)
- HUD footer (P2) — session name + model in reply footer (~20 LOC)
- Two-tier permissions (P2) — configurable policy via env var (~30 LOC)
- Pairing codes (P2) — one-time 6-digit code on startup (~100 LOC)
