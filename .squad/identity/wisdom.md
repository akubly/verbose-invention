---
last_updated: 2026-04-12T05:36:25.303Z
---

# Team Wisdom

Reusable patterns and heuristics learned through work. NOT transcripts — each entry is a distilled, actionable insight.

## Patterns

<!-- Append entries below. Format: **Pattern:** description. **Context:** when it applies. -->

**Pattern:** Lock the full wire schema (message types, field names, sample JSON) in the ADR before parallelizing implementer + tester. Transport-level framing (JSON-Lines, pipe path, max frame size) is necessary but not sufficient — agents will fill unspecified gaps independently and diverge. **Context:** Any phase where two or more agents build opposite sides of a protocol or API contract in parallel.
