You are consolidating related observations from a knowledge vault into a single comprehensive note.
You have a budget of ~{{maxTokens}} tokens for your response.

These {{count}} observations are all of type "{{observation_type}}" and were found to be semantically similar.

Your task: decide whether they should be consolidated into one note, or kept separate.

## Default: consolidate

These observations were grouped because they are semantically similar. The default action is to consolidate them. Only decline if you have a strong reason.

Multiple observations about the same technology, system, component, or concept SHOULD be consolidated — even if they describe different aspects, failure modes, or angles. A single comprehensive reference is more valuable than scattered fragments.

Examples that SHOULD consolidate:
- 3 gotchas about SQLite WAL mode (shared memory, writer locks, checkpoint blocking) → one "SQLite WAL Operational Constraints" note
- 4 trade-offs about CI/CD pipelines (caching, versioning, Docker, commits) → one "CI/CD Pipeline Trade-offs" note
- 3 decisions about the same authentication system → one "Authentication Design Decisions" note

## When NOT to consolidate

Only decline when observations are about genuinely unrelated topics that happen to share a type:
- A decision about database choice + a decision about UI framework + a decision about error handling → these are about completely different systems
- A gotcha about SQLite + a gotcha about Docker networking → unrelated technologies

The key test: would a reader looking up one of these topics benefit from seeing the others in the same note? If yes, consolidate.

## Critical rules

- PRESERVE specific details from each source: file names, error messages, function names, concrete values
- A synthesis that generalizes away specifics is WORSE than the original observations
- Include ALL relevant source IDs in source_ids — no hallucinated IDs, no omissions
- source_ids must be a subset of the IDs shown below
- If only some observations belong together, consolidate the related subset and exclude the unrelated ones
- Wisdom notes should be COMPREHENSIVE but not redundant — include all distinct insights, specifics, and actionable details from the sources, but don't repeat the same point in different words

## Observations

{{candidates}}

---

Respond with JSON only. Two valid formats:

If they should NOT be consolidated:
{"consolidate": false, "reason": "brief explanation"}

If they SHOULD be consolidated:
{"consolidate": true, "title": "Concise title for the wisdom note", "content": "Full markdown content synthesizing all observations. Preserve specifics.", "source_ids": ["id-1", "id-2", "id-3"], "tags": ["tag1", "tag2"]}
