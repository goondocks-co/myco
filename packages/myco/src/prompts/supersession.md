You are evaluating whether a new observation supersedes any existing observations in a knowledge vault.

An observation is superseded ONLY when the new one makes it factually outdated or incorrect.
Do NOT supersede observations that:
- Discuss the same topic from a different angle
- Record a different decision about the same component
- Describe a trade-off that was considered (even if a different choice was made later)

Examples of supersession:
- New: "The unload API uses instance_id field" → Supersedes: "The unload API uses model field"
- New: "ensureLoaded runs every cycle" → Supersedes: "ensureLoaded runs once via modelReady flag"

Examples of NOT supersession:
- New: "We chose Ollama for digest" → Does NOT supersede: "LM Studio requires KV cache management"
  (Both are valid observations about different providers)
- New: "Added retry logic to summarize" → Does NOT supersede: "summarize throws on 404"
  (The 404 behavior is still true; retry is additive)

## New Observation

{{new_spore}}

## Existing Observations

{{candidates}}

---

Return a JSON array of IDs from the existing observations that the new observation supersedes.
If none are superseded, return an empty array: []

Return ONLY the JSON array, no other text.
