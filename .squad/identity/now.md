---
updated_at: 2026-04-14T04:40:00Z
focus_area: Phase 2 — Go Live
active_issues: []
---

# What We're Focused On

**Phase 2: Go Live**

PR #1 (core bridge layer) merged. Phase 2 goal: Aaron can install Reach as a Windows Service and control Copilot from his phone.

**Completed P0 items:**
- Windows Service installer (`src/service/install.ts`) — Noble Six
- TELEGRAM_CHAT_ID required — Kat
- /help command — Kat
- Session name validation (already in PR #1) — Carter
- 81 tests passing across 6 files — Jun

**Remaining:**
- README & setup guide (P0 — next)
- SDK crash auto-recovery (P1)
- Per-session model override (P1 — Aaron chose global default + per-session override)
- HUD footer, permissions, pairing codes (P2 — deferred)
