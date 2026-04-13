Budget: ~7,500 tokens. Use the FULL budget — this is the institutional knowledge tier.

This is the complete project context — an agent reading this should have the equivalent of months of project history and team knowledge. It should be able to make architectural decisions, understand why any part of the system exists, and anticipate risks that aren't obvious from the current code.

This tier exists for complex work: major refactors, architectural reviews, onboarding new team members, or debugging systemic issues where understanding history matters.

## Required Sections

### Project Identity & Vision (~400 tokens)
What is this project? What problem does it solve? Who uses it and how? What's the long-term vision? Ground the agent in purpose so it can evaluate whether proposed changes serve the project's goals.

### Architecture Deep Dive (~800 tokens)
How the system fits together — subsystems, data flows, integration points, deployment model. Include the conceptual architecture (not just file paths) and explain WHY it's structured this way. What are the boundaries? What are the invariants?

### Active Work & Recent History (~1,000 tokens)
Detailed narrative of the last 5-10 sessions. What was built, what problems were solved, what changed and why. Include the story arc — how did the project get from where it was to where it is now?

For each major piece of recent work: what triggered it, what was the approach, what was the outcome, and what's still pending.

### Decision Archive (~1,200 tokens)
The decisions that shaped the project. Each decision should include:
- What was decided
- What alternatives were considered and rejected
- The rationale — why THIS choice over the alternatives
- Whether the decision is still active or has been superseded

Recent decisions (last 2-4 weeks) get full treatment. Older decisions that are still load-bearing get compressed but preserved.

### Accumulated Wisdom & Patterns (~900 tokens)
Everything the team has learned that isn't obvious from reading the code. Organize by domain:

- **Architecture & Design**: Patterns that emerged, abstractions that work, boundaries that matter
- **Operational**: Deployment gotchas, configuration pitfalls, monitoring insights
- **Development**: Testing strategies, debugging approaches, tooling quirks
- **Agent Behavior**: How AI agents interact with this codebase — what they get wrong, what helps them succeed

Each item should be specific and actionable, not generic advice.

### Trade-offs & Design Tensions (~600 tokens)
The active tensions in the system where there isn't a clean answer. For each:
- What's the tension
- What's the current balance point
- What would shift it

These help the agent make judgment calls that align with the team's values and constraints.

### Team Knowledge (~500 tokens)
Who has been working on what? What are their areas of expertise? What's the collaboration model? Include working patterns that affect how the agent should behave.

### Thread History (~900 tokens)
The evolution of major features and initiatives. Not just "what shipped" but "how it evolved" — what was the original idea, how did it change during implementation, what surprised the team?

When the vault is small, cover all threads in detail. As it grows, older threads compress into lessons learned and only active threads get full treatment.

### Risks & Open Questions (~400 tokens)
What could go wrong? What's unresolved? What assumptions might break? What technical debt is accumulating?

### Glossary & Reference (~400 tokens)
Project-specific terminology and concepts. Include terms that have specific meanings in this project that differ from general usage. Key file paths and components that are frequently referenced.

## Priority Rules
- USE THE FULL 7,500 TOKENS — this tier should be DENSE with useful information
- This is the one tier where historical depth matters — don't compress away the story
- Recent activity (last 5-10 sessions) gets narrative detail with context
- Older activity becomes patterns, lessons, and compressed summaries — but key moments are preserved
- Trade-offs, wisdom, and thread history should be the RICHEST sections — they grow over time
- When the vault is small and you can't fill 7,500: go DEEP on what exists — explain reasoning, include examples, explore implications
- When the vault is large and 7,500 feels tight: ruthlessly prioritize by relevance to current work, but preserve foundational decisions and hard-won lessons
