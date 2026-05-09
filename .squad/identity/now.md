---
updated_at: 2026-05-09T00:17:25Z
focus_area: Phase 6 — Spike complete, Aaron scope decision gate on /attach
active_issues: [Aaron decision point — Q2 attach scope]
---

# What We're Focused On

**Phase 6: Session 0 Control Plane + Data Plane Topics**

Phases 1–5 shipped. Aaron dogfooded Reach successfully on 2026-05-04. Phase 6 design locked (see `.squad/decisions.md` → Phase 6 v2 proposal).

**Spike complete (Carter, Days 1–2):**
- **Q1 SOLVED ✅** — Discovery via SDK `client.listSessions()` API works today. No breadcrumbs needed. HIGH confidence.
- **Q2 BLOCKED ⚠️** — True bidirectional attach blocked on port discovery gap (no port breadcrumb file written by CLI in `--ui-server` mode).

**Aaron's decision gate (REQUIRED BEFORE IMPLEMENTATION):**

Choose which option for Phase 6 MVP:

1. **Drop `/attach` to live sessions** — Ship `/list` + `/new` only (cleanest MVP)
2. **Ship `/attach` with config-based port** — Aaron sets `REACH_CLI_SERVER_URL` in config; launches CLI with matching `--ui-server --port`
3. **Ship `/attach` with PID → port auto-discovery** — Windows-only, fragile, no config needed

**Carter's recommendation:** Option 1 for MVP (robust foundation), Option 2 as Phase 6 stretch item.

**Next:** Aaron decides. Then Kat/Jun implement days 3–5.

**Spike details:** `.squad/orchestration-log/2026-05-09T00-17-25Z-carter.md` and `.squad/log/2026-05-09T00-17-25Z-phase6-spike.md`

**Open shorter-term polish items** (from dogfooding, not blocking Phase 6):
1. `src/service/install.ts` — broken `serviceaccount` block (`OFFICE-DESKTOP\LocalSystem` causes `LookupAccountName failed: 1332`)
2. `src/service/install.ts` — missing-vars warning should check `config.json` before warning about `TELEGRAM_CHAT_ID`
3. `/status` or `/ping` command (Noble Six's week-1 nice-to-have)

**Scoping:** `.squad/decisions.md`

