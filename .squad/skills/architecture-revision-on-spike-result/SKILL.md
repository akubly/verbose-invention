# Skill: Architecture Revision on Spike Result

## When to Use

A locked architectural proposal assumed a spike would answer a feasibility question. The spike has returned with evidence that changes the design picture — either the assumed-feasible path is blocked, or an unanticipated path has opened. The locked proposal needs formal revision.

## Inputs

1. **The locked proposal** — the prior architectural decision, including its assumptions and open questions.
2. **Spike results** — what the spike found, including any follow-up investigations.
3. **The original requirements** — why the proposal exists; what user/system need it serves.

## Steps

### 1. Identify What Changed

List the specific assumptions in the locked proposal that the spike confirmed, refuted, or made irrelevant. Be precise: "Q2 assumed SDK attach was feasible; spike found it blocked by port-discovery gap; follow-up found extension API sidesteps the gap entirely."

### 2. Steelman Both Directions

For every viable path forward, build the strongest case *for* it:
- **Stay the course (with adjustments):** What does the original design look like if you accept the spike's constraints? What do you lose?
- **Revise toward new evidence:** What does the design look like if you adopt the newly-discovered approach? What do you gain, and what new risks appear?

### 3. Explicit Trade-Off Grid

Evaluate each option across consistent dimensions:
- Install footprint / operational complexity
- Coupling / upgrade story (what breaks if dependencies change?)
- Failure modes (what happens when the new component crashes, misconfigures, or is absent?)
- Security surface (what new trust boundaries appear?)
- Value delivered vs. original requirements
- Incremental effort

### 4. Make the Call

State the decision plainly. Name the rationale. The decision should be traceable to the trade-off grid — not to intuition or momentum.

### 5. Write the Revised Proposal

Structure:
- **Header:** Status PROPOSED, Supersedes reference to the LOCKED entry, trigger description.
- **Section 0:** The decision and its rationale (this is the "why we changed" section).
- **Carried-forward decisions:** Explicitly list what survives from the locked design.
- **New decisions:** What the revision adds.
- **Open questions:** What needs ADR-level locking before implementation.
- **MVP scope:** Concrete file plan — new files, changed files, config.
- **Team impact:** What changes for each team member vs. the locked design.
- **Risks:** Severity + mitigation for each new risk.
- **ADRs to lock:** Decisions that need formal recording before code starts.
- **Migration table:** Side-by-side: locked design → revised design, with change type.

### 6. Update History

Record in the architect's history:
- What triggered the revision
- The decision and rationale (compressed)
- Team-member scope deltas
- Pointer to the proposal file

## Anti-Patterns

- **Defending the prior design out of momentum.** LOCKED means "best design given prior evidence," not "permanent."
- **Patching instead of revising.** If the spike changes the architecture's shape, write a new proposal. Don't bolt new components onto the old design without re-evaluating coherence.
- **Skipping the steelman.** Even if the new evidence feels decisive, force yourself to articulate the case for staying the course. You might find the new path has hidden costs.
- **Revising without traceability.** The revised proposal must make the evidence chain visible: what was assumed → what was found → what changed → why.

## Outputs

1. Revised proposal in decisions inbox (PROPOSED, supersedes LOCKED entry).
2. Updated architect history with decision rationale.
3. Clear team-member scope deltas for downstream agents.
