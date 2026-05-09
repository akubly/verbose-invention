---
updated_at: 2026-05-09T07:06:43Z
focus_area: Phase 6 — Session 0 control plane (DESIGN LOCKED, awaiting spike)
active_issues: []
---

# What We're Focused On

**Phase 6: Session 0 Control Plane + Data Plane Topics**

Phases 1–5 shipped. Aaron dogfooded Reach successfully on 2026-05-04 (paired, daemon running as Windows Service `reach.exe`). During dogfooding he hit the cwd/branch limitation (Reach is bound to one repo) and that triggered the Phase 6 design conversation.

**Locked model** (see `.squad/decisions.md` → Phase 6 v2 proposal):
- Reach is a remote i/o channel for an existing CLI process — NOT a session creator, NOT a git-aware broker.
- Session 0 = General topic. Always present. Desktop mode (silent, only `/afk` works) ↔ AFK mode (full control surface).
- Data-plane topics = 1:1 with a CLI process, created on-demand from session 0 during AFK, auto-archive on `/back` or session death.
- Cold-start fix: phone-side `/afk` works if Aaron forgets at the desktop.

**Next step:** Carter spike (1–2 days) on the SDK question — can Reach discover and bidirectionally attach to externally-running CLI sessions? This gates the MVP. **Aaron has NOT yet kicked this off.** First action of next session: confirm Aaron wants the spike, then dispatch Carter.

**Open shorter-term polish items** (from dogfooding, not blocking Phase 6):
1. `src/service/install.ts` — broken `serviceaccount` block (`OFFICE-DESKTOP\LocalSystem` causes `LookupAccountName failed: 1332`). Hand-fixed Aaron's local install; needs proper fix in code.
2. `src/service/install.ts` — missing-vars warning should check `config.json` before warning about `TELEGRAM_CHAT_ID`.
3. `/status` or `/ping` command (Noble Six's week-1 nice-to-have).

**Scoping:** `.squad/decisions.md`

