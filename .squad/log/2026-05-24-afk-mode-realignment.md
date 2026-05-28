# Session Log: /afk Mode Realignment & ADR-11

**Timestamp:** 2026-05-24T22:56:13-07:00  
**Phase:** 7 Planning / Realignment  
**Coordinator:** N/A (background task)

---

## Summary

Round-1/round-2 analysis cycle resolved the primary architectural gap for CLI-initiated /afk mode. ADR-11 drafted, Aaron provided 25 locked decisions, Carter's skill-spike research closed Issue #6. Phase 7 scope locked: /afk + /back MVP with mirror semantics and machine-wide mode.

---

## Agents Spawned

1. **Noble Six (background, opus-4.6):** ADR-11 draft + round-2 realignment. Drafted 
oble-six-adr11-afk-mode.md + 
oble-six-afk-realignment.md + 
oble-six-afk-mode-opens.md + 
oble-six-dogfood-gate.md. Amended §3 + §12 with Carter's skill-spike verdict.

2. **Carter (background, sonnet-4.6):** Skill-spike research on Copilot CLI SKILL.md viability. Verdict: NO (SKILL.md = markdown only; must use SDK commands field). Authored carter-skill-spike.md (HIGH confidence). Also authored protocol gap analyses pre- and post-realignment.

---

## Artifacts Merged into Decisions

- ADR-11: /afk Mode + Multi-Session Mirror Bridge (PROPOSED → ACCEPTED with amendments)
- Carter's skill spike verdict (NO — HIGH confidence)
- Aaron's 25 locked decisions (from copilot-directive-afk-locked-decisions.md)
- Realignment analysis (noble-six-afk-realignment.md)
- 16 pre-code open questions (noble-six-afk-mode-opens.md)
- Carter's post-realignment protocol opens (carter-afk-mode-protocol-opens.md)
- Protocol gap analyses (carter-afk-protocol-gaps.md)
- Kat's UX + Telegram opens (kat-afk-telegram-gaps.md, kat-afk-mode-ux-opens.md)
- Jun's test coverage audit (jun-afk-test-gaps.md)
- Carter's permission prompt bug investigation (carter-permission-prompt-dogfood-bug.md)
- Kat's eager prompt registry decision (kat-eager-prompt-registry.md — 2026-05-23)
- Noble Six's dogfood gate criteria (noble-six-dogfood-gate.md)

---

## Phase 7 Scope (Locked)

**IN (MVP):**
- /afk and /back slash commands (extension.mjs)
- Machine-wide mode toggle (daemon singleton)
- Mirror semantics (Telegram→CLI echoed; CLI→Telegram; local keystrokes NOT mirrored)
- 8 new pipe message types (afk.request, afk.activated, back.request, back.confirmed, mode.changed, mirror.input, relay.command design, session.registered amendment)
- Daemon-owned sessionId↔topicId map
- Topic creation (serialized 200–300ms gaps; 429 retry)
- Loop avoidance via origin tags

**OUT (Phase 8+):**
- Resume-from-Telegram
- Spawn-from-Telegram
- relay.command implementation
- Persistent mode state (crash recovery)

---

## Key Decisions

1. **Entry point:** SDK's commands field on JoinSessionConfig in extension.mjs (~25 lines). SKILL.md rejected.

2. **Mode state:** Machine-wide daemon singleton. Memory-only v1 acceptable; persistent file is Phase 8+ upgrade.

3. **Topic naming:** <session-name> (<session-id>) with user-settable session names.

4. **Resume:** Keyed by session name. Registry lookup from CLI.

5. **Permission prompts:** Cross-topic alert in General with jump button to topic-scoped prompt.

6. **New CLI sessions during AFK:** Auto-join fleet; auto-create topic on registration.

---

## Next Steps

1. Carter: Validate SDK commands surface with 5-minute /ping smoke test
2. Kat: Implement daemon-side AFK state machine + topic creation
3. Jun: Write 8 test scenarios for /afk→topic→/back flow
4. Noble Six: Monitor ADR-11 amendments as implementation surfaces edge cases

---

## Files Modified This Session

- .squad/decisions.md — 14 inbox files merged (67.7KB appended); inbox/ cleared
- .squad/log/orchestration/noble-six-2026-05-24.log.md — created
- .squad/log/orchestration/carter-2026-05-24.log.md — created
- .squad/agents/*/history.md — cross-agent notes appended (below)
