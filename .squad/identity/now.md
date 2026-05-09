---
updated_at: 2026-05-09T07:40:08Z
focus_area: Phase 6 — Spike complete, extension bridge viable, Aaron scope decision
active_issues: [Aaron decision point — Option A (drop /attach) vs Option B (extension bridge /attach)]
---

# What We're Focused On

**Phase 6: Session 0 Control Plane + Data Plane Topics**

Phases 1–5 shipped. Aaron dogfooded Reach successfully on 2026-05-04. Phase 6 design locked (see `.squad/decisions.md` → Phase 6 v2 proposal).

**Spike complete (Carter, Days 1–2 + follow-up):**
- **Q1 SOLVED ✅** — Discovery via SDK `client.listSessions()` API works today. No breadcrumbs needed. HIGH confidence.
- **Q2 RESOLVED ✅** — Extension API surface viable. Copilot CLI extension bridge eliminates port-discovery gap entirely. `@github/copilot-sdk@0.2.2` exports `joinSession()`, `session.send()`, `session.on()`. Extension runs as forked child with JSON-RPC/stdio to CLI. NO port file needed. Bidirectional `/attach` becomes clean and authoritative.

**NEW: Extension-Based Bridge Viable**

- **How:** Extension registers on CLI startup, opens named pipe/loopback socket to daemon, streams events, accepts injected prompts.
- **Setup:** Write `extension.mjs` to user extensions dir; automatable in `reach install`.
- **Effort:** ~2 days on top of MVP.
- **Tradeoff:** Reach gains per-user CLI extension install footprint (in addition to daemon).

**Aaron's decision gate (REQUIRED BEFORE IMPLEMENTATION):**

Choose which option for Phase 6 MVP:

1. **Option A (Original MVP)** — Ship `/list` + `/new` only (cleanest MVP, low risk)
2. **Option B (Extended MVP via Extension Bridge)** — Ship `/list` + `/new` + `/attach` to live sessions via extension bridge (full bidirectional, ~2 day add-on, medium risk)

**Carter's recommendation:** Option A for MVP (robust foundation, 1-day faster), Option B as first post-MVP feature (extension approach is solid).

**Next:** Aaron decides scope. Then Noble Six, Kat, Jun implement days 3–5 based on Aaron's choice.

**Phase 6 plan likely shifts toward extension-based architecture if Aaron chooses Option B.** Design is cleaner than port-file polling; enables true session bridging.

**Spike details:** 
- Decision merged to `.squad/decisions.md` (carter-cli-extension-bridge)
- Orchestration: `.squad/orchestration-log/2026-05-09T07-40-08Z-carter.md`
- Session: `.squad/log/2026-05-09T07-40-08Z-cli-extension-bridge.md`
- New skill (for future work): `.squad/skills/sdk-extension-introspection/SKILL.md`

**Open shorter-term polish items** (from dogfooding, not blocking Phase 6):
1. `src/service/install.ts` — broken `serviceaccount` block (`OFFICE-DESKTOP\LocalSystem` causes `LookupAccountName failed: 1332`)
2. `src/service/install.ts` — missing-vars warning should check `config.json` before warning about `TELEGRAM_CHAT_ID`
3. `/status` or `/ping` command (Noble Six's week-1 nice-to-have)

**Scoping:** `.squad/decisions.md`

