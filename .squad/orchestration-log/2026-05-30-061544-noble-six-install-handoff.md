# Orchestration Log: Noble Six Phase 8.5 Install Design

**Timestamp:** 2026-05-30T06:15:44Z  
**Agent:** Noble Six (claude-sonnet-4.6)  
**Session Role:** Lead / Architect  
**Output:** `.copilot/reach-install-handoff.md` (340 lines, Phase 8.5 design doc)

## Summary

Designed Phase 8.5 Reach install story. Recommendation: **Option C** — single `npm run install` orchestrator covering:
1. Config wizard (token validation, allowed-user-IDs prompt)
2. Extension copy (new `src/install/copyExtension.ts`)
3. Service install (existing `src/service/install.ts`, unchanged)

Sub-commands exposed:
- `npm run install:extension` — extension copy only (immediate dogfood unblock)
- `npm run uninstall` — cleanup both daemon + extension

**Scope:** Windows-only Phase 8.5; cross-platform deferred to Phase 9.

**Design Phase:** Complete. 5 UX preference questions documented for Aaron.

**Status:** Awaiting Aaron decisions before Phase 8.5 implementation sprint.
