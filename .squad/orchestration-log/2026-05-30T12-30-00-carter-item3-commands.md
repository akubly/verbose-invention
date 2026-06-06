# Orchestration Log — Carter Item 3: /cwd and /new --cwd (Phase 9 T6+T7)

**Date:** 2026-05-30  
**Agent:** Carter (Bridge Dev)  
**Task:** Phase 9 Item 3 T6+T7 — /cwd command group + /new --cwd flag  
**Status:** ✅ Complete

## Agent Assignment

- **Role:** Bridge Dev
- **Model:** claude-sonnet-4.6
- **Context:** Implement /cwd commands and --cwd flag parser

## Deliverables

### Files Changed

- `src/bot/commands.ts` — Added `'cwd'` to BOT_COMMANDS
- `src/bot/handlers.ts` — `/cwd list|add|remove` commands, `/new --cwd` flag parser

### Commands Implemented

#### `/cwd list`
Lists all known CWDs with last-used times. General Topic only.

#### `/cwd add <alias> <path>`
Registers alias for directory. Validates alias and path. General Topic only.

#### `/cwd remove <alias>`
Removes alias from registry. General Topic only.

#### `/new <name> [--model <model>] [--cwd <alias-or-path>]`
Creates session with optional CWD. Flags position-independent.

### Key Decisions

1. **General Topic only** — `/cwd` commands forbidden in session topics; check `ctx.message?.message_thread_id === undefined`
2. **Position-independent flag parsing** — Refactored regex to handle `--model` and `--cwd` anywhere in input
3. **Path vs alias disambiguation** — Windows: `^[a-zA-Z]:\\` or `\\\\`; otherwise alias lookup
4. **Registry API** — `registry.register()` already had optional `cwd` parameter (defaults to `process.cwd()`)
5. **Error messages** — Friendly, actionable (alias collision, invalid alias, invalid path, in session topic, unknown alias)
6. **relativeTime() helper** — Private utility for "last used 2h ago" formatting

### Help Text

```
/cwd list|add|remove — Manage known cwd aliases (General Topic only)
/cwd list — list all known cwds with last-used times
/cwd add <alias> <path> — register a new alias for a directory
/cwd remove <alias> — remove an alias from the registry
/new <name> [--model <model>] [--cwd <alias-or-path>] — Create a session
```

### Known Limitations

- Path detection Windows-only (Unix `/` detection deferred to Phase 10 cross-platform phase)

### Coordination Notes

- `'cwd'` added to BOT_COMMANDS (prevents relay)
- Kat's helpers (T5) used for validation and lookup
- Jun writes tests for both T6 and T7

## Outcome

/cwd command group functional; /new --cwd flag parser ready; Aaron's feedback item 3 resolved.
