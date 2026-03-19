You are summarizing a coding session for user "{{user}}" (session "{{sessionId}}").
You have a budget of ~{{maxTokens}} tokens. Use the full budget to produce a rich, detailed narrative.

## Session Content
{{content}}

## Task
Write a detailed narrative summary of this session. This summary will be used by the digest engine to synthesize project understanding, so richness and accuracy matter more than brevity.

Cover:
- **What was accomplished** — features built, bugs fixed, refactors completed
- **Key decisions made** — what was chosen and why, including alternatives that were rejected
- **Problems encountered** — what went wrong, how it was debugged, what the root cause was
- **Discoveries and learnings** — anything surprising or non-obvious that was learned
- **Current state** — where things stand at the end of the session, what's next

Focus on outcomes and reasoning rather than individual tool calls. Include enough context that someone reading this summary months later would understand what happened and why.

Respond with plain text only, no JSON or markdown fences.
