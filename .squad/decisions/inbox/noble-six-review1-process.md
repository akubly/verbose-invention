# Review Cycle 1 — Process Improvement Note

**Author:** Noble Six  
**Date:** 2026-05-22  
**Finding:** I7 — `install.ts` service-account refactor mixed in with Phase 6

## Disposition

The `install.ts` refactor (Kat, ADR-5) was correctly scoped to ADR-5's decision
but shipped in the same branch as Phase 6 bridge work. This made the diff larger
than necessary for reviewers.

## Process Improvement (Future PRs)

- Orthogonal refactors that serve an ADR but don't depend on other Phase 6 code
  should ship in a separate PR, merged first, so the main Phase 6 PR is smaller.
- Not actionable retroactively — the code is correct, tested, and merged.
