Rate how related these two coding sessions are on a scale of 0.0 to 1.0.

## Current Session
{{currentSummary}}

## Candidate Parent Session
{{candidateSummary}}

## Scoring Guidelines

1. **Same feature/bug** (high weight): Both sessions working on the same feature, bug fix, or component? Same file names or modules?
2. **Continuation pattern** (high weight): Does the current session continue work from the candidate? References decisions, plans, or outcomes?
3. **Related work** (medium weight): Related but distinct features? Same area of the codebase?
4. **Unrelated** (low score): Different features, different parts of the codebase.

## Score Ranges

- 0.9-1.0: Direct continuation (picks up exactly where the other left off)
- 0.7-0.9: Same feature/bug (clearly related work)
- 0.5-0.7: Related work (same area, related features)
- 0.3-0.5: Loosely related (some overlap but different focus)
- 0.0-0.3: Unrelated (different work entirely)

Respond with ONLY a single number between 0.0 and 1.0.