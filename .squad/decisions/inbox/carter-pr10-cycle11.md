# carter-pr10-cycle11: relativeTime() Guards

**Date:** 2026-06-05  
**Author:** Carter (Bridge Dev)  
**PR:** #10 — Cycle 11

---

## Decision 1: NaN fallback string → `'unknown'`

**Choice:** Return `'unknown'` when `Date.parse(iso)` yields `NaN`.

**Rationale:**
- `'just now'` would be misleading — the timestamp isn't *recent*, it's *unreadable*.
- `'unknown'` is honest and already fits the output vocabulary of the `/cwd list` rendering
  (`last used unknown`), which reads naturally as a data-quality indicator rather than a time claim.
- It avoids emitting garbled strings like `'NaNd ago'` that would confuse users and
  look like bugs in screenshots.

---

## Decision 2: Future timestamp clamp → `diffMs = Math.max(0, ...)`

**Choice:** Clamp `diffMs` to `0` when the stored timestamp is ahead of `Date.now()`.

**Rationale:**
- Small positive skews (seconds to minutes) arise from NTP drift between the machine that
  wrote the config and the machine running the bot. They are not errors — they are expected noise.
- Clamping to 0 means the `mins < 1` branch fires and returns `'just now'`, which is the
  correct human interpretation of "happened approximately now".
- Negative diffMs would propagate through `Math.floor` into negative minute/hour/day values,
  producing output like `'-1m ago'` — nonsensical and unhandled by the existing branches.
- An explicit `Math.max(0, ...)` is self-documenting and cheaper than adding a dedicated
  negative-branch to an otherwise clean function.
