# Orchestration Log: Carter Extension Install Conventions

**Timestamp:** 2026-05-30T06:15:44Z  
**Agent:** Carter (explore)  
**Session Role:** Research  
**Deliverable:** Read-only research; input to Phase 8.5 handoff

## Summary

Gathered platform-specific extension install conventions:

**Windows:**
- Primary: `%APPDATA%\GitHub Copilot\User\extensions\{org}\extension.mjs`
- `%APPDATA%` resolves via `process.env.APPDATA`
- Requires directory creation (node `fs.mkdir` with recursive flag)
- No elevated permissions needed for typical user APPDATA writes

**macOS/Linux:**
- Parallel convention: `~/.config/GitHub Copilot/User/extensions/{org}/` (defer to Phase 9)

**Cross-cutting concerns:**
- Symlink for dev (Option 2a); hard copy for release (Option 2b)
- Wipe flag for uninstall (safe vs. aggressive cleanup)

**Status:** Inventory complete; fed to Noble Six for install handoff design.
