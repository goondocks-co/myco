You are consolidating related observations from a knowledge vault into a single comprehensive note.

These {{count}} observations are all of type "{{observation_type}}" and were found to be semantically similar.

Your task: decide whether they should be consolidated into one note, or kept separate.

## When to consolidate

- Observations share a root cause or describe the same pattern from different angles
- They would be more useful as a single comprehensive reference than as separate fragments
- The combined insight is richer than any individual observation

## When NOT to consolidate

- Observations are merely related by topic but describe genuinely different insights
- Each observation captures a unique perspective that would be lost in synthesis
- The observations contradict each other (they should remain separate to preserve the disagreement)

## Critical rules

- PRESERVE specific details from each source: file names, error messages, function names, concrete values
- A synthesis that generalizes away specifics is WORSE than the original observations
- Include ALL relevant source IDs in source_ids — no hallucinated IDs, no omissions
- source_ids must be a subset of the IDs shown below
- Returning consolidate: false is the correct answer when observations are complementary rather than overlapping

## Observations

{{candidates}}

---

Respond with JSON only. Two valid formats:

If they should NOT be consolidated:
{"consolidate": false, "reason": "brief explanation"}

If they SHOULD be consolidated:
{"consolidate": true, "title": "Concise title for the wisdom note", "content": "Full markdown content synthesizing all observations. Preserve specifics.", "source_ids": ["id-1", "id-2", "id-3"], "tags": ["tag1", "tag2"]}
