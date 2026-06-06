# Carter → Jun: F1 Relay Capability Fix — What to Assert

**Date:** 2026-06-06  
**Branch:** `feature/channel-abstraction`  
**Commit:** e1f3f4d  
**Author:** Carter

---

## What Was Fixed

The relay (`src/relay/relay.ts`) unconditionally sent a `"…"` placeholder and
called `editMessage` during streaming, ignoring the `ChannelPort` capability
flags. This violated the fallback behaviors documented in `src/channel/port.ts`.

The fix introduces an explicit three-case branch at the start of the streaming
path, gated on `channel.capabilities.supportsStreaming` and
`channel.capabilities.supportsMessageEdit`:

| supportsStreaming | supportsMessageEdit | Relay behavior |
|---|---|---|
| `true` | `true` | **Case A (Telegram):** `"…"` placeholder → throttled 800ms stream edits → final `editMessage`. Byte-identical to pre-fix code. |
| `false` | `true` | **Case C:** `"thinking…"` placeholder → silent accumulation → single final `editMessage`. No intermediate edits. |
| `true` or `false` | `false` | **Case B:** No placeholder. Silent accumulation. Single `sendMessage` with the complete response. `editMessage` never called. |

---

## Precise Assertions Jun Should Add

These go in `tests/relay/relay.test.ts` (or a new
`tests/relay/relay.capabilities.test.ts`). Use a `FakeChannel` (or a copy of
`makeMockChannel()`) with the capability flags overridden for each scenario.

### Case B — `supportsMessageEdit: false`

```
capabilities: { supportsStreaming: true, supportsMessageEdit: false, … }
```

1. **`editMessage` is never called** — `expect(channel.editMessage).not.toHaveBeenCalled()` after a full `relay()` run with a normal response.
2. **Exactly one `sendMessage`** containing the full assembled response — `expect(channel.sendMessage).toHaveBeenCalledTimes(1)` and the argument contains the expected text.
3. **No `"…"` placeholder** — the single `sendMessage` call must NOT be `"…"` (it is the final response).
4. **Error path:** when `session.send` throws, `editMessage` is still never called and `sendMessage` is called once with a string starting with `"❌ Error:"`.

### Case C — `supportsStreaming: false`, `supportsMessageEdit: true`

```
capabilities: { supportsStreaming: false, supportsMessageEdit: true, … }
```

1. **First `sendMessage` is `"thinking…"`** — `expect(channel.sendMessage).toHaveBeenNthCalledWith(1, ctx, 'thinking…')`.
2. **`editMessage` called exactly once** (the final replacement) — `expect(channel.editMessage).toHaveBeenCalledTimes(1)` and the argument contains the full response text. *(For a multi-chunk response, exactly one `editMessage` plus N-1 follow-up `sendMessage` calls for overflow chunks.)*
3. **No intermediate stream edits** — assert `editMessage` call count ≤ 1 even when the mock session emits many chunks. The count must not grow proportionally with chunk count.
4. **Error path:** when `session.send` throws, `sendMessage` was called once (`"thinking…"`) and `editMessage` was called once with `"❌ Error: …"`.

### Case A regression — `supportsStreaming: true`, `supportsMessageEdit: true`

The existing tests already cover this path. No new assertions needed here, but
confirm that the existing "sends placeholder '…' reply then edits with final
assembled response" test still passes (it should — Case A is byte-identical).

---

## FakeChannel Helper Pattern

```typescript
function makeCapabilityChannel(overrides: Partial<ChannelCapabilities>): ChannelPort & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
} {
  const base = makeMockChannel(); // existing helper
  (base as any).capabilities = { ...base.capabilities, ...overrides };
  return base;
}
```

This lets each capability test override only the flags it needs while inheriting
the rest of the mock's defaults.

---

## Files Touched in This Fix

- `src/relay/relay.ts` — three-case capability branch replacing the original
  unconditional streaming block.
- `.squad/agents/carter/history.md` — F1 learning appended under "## Learnings".
- `.squad/decisions/inbox/carter-f1-relay-capability-fix.md` — this file.

Port contract (`src/channel/port.ts`) was NOT touched — it was already correct.
