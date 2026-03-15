You are analyzing a coding session buffer for session "{{sessionId}}".

## Events ({{eventCount}} total)
{{toolSummary}}

## Task
Analyze these events and produce a JSON response with exactly this structure:
{
  "summary": "A concise narrative of what happened in this session (2-4 sentences).",
  "observations": [
    {
      "type": "gotcha|bug_fix|decision|discovery|trade_off",
      "title": "Short descriptive title",
      "content": "Detailed explanation of the observation.",
      "tags": ["relevant", "tags"]
    }
  ]
}

## Type-Specific Fields
Include these additional fields when appropriate for the observation type:

- **bug_fix**: add "root_cause" (what caused the bug) and "fix" (what resolved it)
- **decision**: add "rationale" (why this choice) and "alternatives_rejected" (what was considered and why not)
- **trade_off**: add "gained" (what was achieved) and "sacrificed" (what was given up)

These fields are optional — only include them when the session provides clear evidence.

## Observation Guidelines
Only include observations that meet ALL criteria:
- Valuable to a teammate encountering the same code/problem
- Not obvious from reading the code itself
- Not specific to this session's transient state

Types:
- "gotcha": A non-obvious problem, pitfall, or workaround
- "bug_fix": Root cause of a bug and what fixed it
- "decision": An architectural or technical choice, with rationale and rejected alternatives
- "discovery": A significant learning about the codebase, tooling, or domain
- "trade_off": What was sacrificed and why

Routine activity (file reads, searches, test runs, navigation) goes in the summary only.
Target 0-5 observations. Err on fewer, higher-quality observations.

Respond with valid JSON only, no markdown fences.
