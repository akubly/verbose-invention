# Kat — History (Summarized 2026-05-30 → Phase 9 complete)

## Identity & Role

- **Agent:** Kat (Backend Dev, AFK Mode Implementation, Config & Secrets, README Docs)
- **Project:** Reach — TypeScript daemon bridging Telegram to GitHub Copilot CLI
- **Domain:** AFK mode controller, stream routing, relay re-targeting, config validation, secret redaction
- **Joined:** 2026-05-07

## Current Status

**Phase 9 COMPLETE. Cycle 3 README fixes shipped.** Cycle 1: I10 (validatePath warning) + I11 (redactSecrets module) shipped. Cycle 2: Verified + ProgramData deferred. Cycle 3: Skeptic caught docs drift (TELEGRAM_ALLOWED_USER_IDS + REACH_PERMISSION_POLICY + /resume signature) — fixed in README.md. Branch user/aaron/phase9 (4 commits ahead), 783 tests passing. Ready for merge.

**Test baseline:** 783 passed / 4 skipped / 1 todo. tsc clean, lint zero warnings.

---

## Major Work Summary

### Phase 9 — Secret Redaction & Config Validation (Cycles 1–3)

**Cycle 1 – I10 & I11:**
- **I10 — validatePath warning:** Extended return type `{ ok: true; normalized: string; warning?: string }`. Windows-only sensitive-prefix detection (WINDIR, Program Files, other users). Junction/symlink resolution. Caller surfaces warning before adding entry (warn-not-block per Aaron).
- **I11 — redactSecrets module:** Daemon-side regex engine with 3 pattern groups (keyword-adjacent, high-entropy base64, URL-embedded). Over-redaction bias. Called from afkMode.ts before Telegram delivery. Module: `src/bot/redactSecrets.ts`.

**Cycle 2 – Verification:**
Verified implementations. Security reviewer diagnosed AWS key leakage (missing `/` and `+` in base64 charset) — fixed by Carter in C2-I1. ProgramData prefix noted for Phase 10.

**Cycle 3 – README Documentation Drift (Kat):**
Skeptic flagged three docs-vs-runtime mismatches:
- **TELEGRAM_ALLOWED_USER_IDS:** README listed as "Required"; runtime treats as optional. Reclassified to "Strongly Recommended" with security callout: "If not set, ANY user in the configured Telegram chat can control the daemon."
- **REACH_PERMISSION_POLICY:** Default `approveAll` blocks Telegram mirror input (safety measure). Added full policy descriptions to Configuration section and Environment Variables table.
- **/resume command:** README showed `/resume` with no argument; implementation requires `/resume <session-name>`. Fixed. Spot-checked all other command signatures (`/new`, `/list`, `/remove`, `/pair`, `/help`, `/status`, `/cwd`) — all match.

Decision doc: `.squad/decisions/inbox/kat-phase9-review-cycle3-readme.md`

### Phase 8.5 — Install Documentation

README install section rewritten. Quick Start, Installation subsections, Dev Workflow, Upgrading, Uninstall, Platform. Net −17 lines (consolidation).

### Phase 8 — AFK Mode Stable

F4 refactor: stream router extracted (133 LOC). AFK mode 649 LOC. Fleet validation passed (N=20 concurrent).

### Phase 7 & Earlier — AFK Mode, Protocol Drift, PR Cycles

ADR-11 implementation (machine-wide mode state, session↔topic mapping, relay re-targeting). Key invariants: compensation serialization, registry lastTopicId on rollback, detached close timeout-bounded. Protocol drift tests established.

---

## Key Learnings

**Phase 9 I10 Pattern:** When a regex makes a runtime check impossible (e.g., `ALIAS_REGEX` blocks all `-` prefixes), remove the check and document the invariant in regex JSDoc instead of dead code.

**Phase 9 I11 Pattern:** Pattern order matters in regex replacements. Run most-specific first (keyword-adjacent) so captured groups are replaced before later passes see them, avoiding double-matches.

**exactOptionalPropertyTypes:** Return `{ ok: true, normalized, warning }` without including `warning: undefined` as separate branches. Applies to all objects with optional fields.

**Cross-file citations:** Use symbol names instead of line numbers (`handlers.ts — bot.command('new', ...)` not `handlers.ts:53`). Symbols remain stable across refactors.

**EventEmitter tuple types:** Updating tuple type cascades correctly through generic overload in interface. Check protocol-drift test when adding optional fields.

---

## Phase 10 Backlog

- ProgramData prefix added to sensitive-dir list
- Cross-platform path detection in /new --cwd (Unix support)
