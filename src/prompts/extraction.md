You are analyzing a coding session buffer for session "{{sessionId}}".
You have a budget of ~{{maxTokens}} tokens for your response.

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
      "content": "Detailed explanation of the observation. Be thorough — include the context, the specifics, and why this matters. A teammate reading this should fully understand the issue without needing to look at the code.",
      "tags": ["relevant", "tags"]
    }
  ]
}

## Type-Specific Fields
Include these additional fields when appropriate for the observation type:

- **bug_fix**: add "root_cause" (what caused the bug — be specific) and "fix" (what resolved it — include the approach, not just the file name)
- **decision**: add "rationale" (why this choice was made — include constraints and context) and "alternatives_rejected" (what was considered and why it was ruled out)
- **trade_off**: add "gained" (what was achieved) and "sacrificed" (what was given up, and why the tradeoff was acceptable)

These fields are optional — only include them when the session provides clear evidence.

## Observation Guidelines
Only include observations that meet ALL criteria:
- Valuable to a teammate encountering the same code/problem
- Not obvious from reading the code itself
- Not specific to this session's transient state

Types:
- "gotcha": A non-obvious problem, pitfall, or workaround — include the symptom, the root cause, and the fix or workaround
- "bug_fix": Root cause of a bug and what fixed it — include enough detail that someone could recognize the same bug
- "decision": An architectural or technical choice — explain the reasoning, constraints, and what was rejected
- "discovery": A significant learning about the codebase, tooling, or domain — explain what was surprising or non-obvious
- "trade_off": What was sacrificed and why — include both sides of the tradeoff and what tipped the balance

Routine activity (file reads, searches, test runs, navigation) goes in the summary only.
Target 0-5 observations. Err on fewer, higher-quality observations with rich detail over many thin ones.

Respond with valid JSON only, no markdown fences.
