Budget: ~5,000 tokens. Use the FULL budget — this is a rich context tier.

This is deep onboarding — an agent reading this should understand the project as well as a team member who's been on the project for weeks. It needs to know not just what and why, but the patterns, trade-offs, accumulated wisdom, and team dynamics that shape daily work.

## Required Sections

### Project Identity & Purpose (~400 tokens)
What is this project? What problem does it solve? Who uses it? What's the vision? Ground the agent in the project's reason for existing.

### Architecture & Key Components (~600 tokens)
How the system fits together at a high level. Major subsystems, data flow, integration points. Focus on the concepts and boundaries, not file paths — the agent can read code for implementation details.

### Current State & Active Work (~700 tokens)
What's in progress right now? What branches are active? What's the immediate priority? What shipped recently? Give enough detail that the agent could pick up a task without asking for orientation.

### Decision Log (~800 tokens)
The important decisions that shaped the project and are still relevant. For each: what was decided, what alternatives were considered, and WHY this path was chosen. These prevent agents from relitigating settled questions or unknowingly violating established direction.

When the vault is large, compress older decisions but preserve their conclusions. Recent decisions get full treatment with rationale and alternatives rejected.

### Accumulated Wisdom (~700 tokens)
Cross-cutting lessons the team has learned. Recurring gotchas, established patterns, things that aren't obvious from the code. These are the "we learned this the hard way" items that save time.

Organize by theme (e.g., "Configuration & Settings", "Testing Patterns", "Agent Behavior") rather than chronologically.

### Trade-offs & Tensions (~500 tokens)
Active tensions in the system — things where there isn't a clean answer and the agent needs to understand the balance. Performance vs. quality, simplicity vs. flexibility, local vs. remote, etc. These help the agent make judgment calls that align with the team's values.

### Team Dynamics & Workflow (~400 tokens)
Who is working on what, and how? Communication patterns, review processes, branch strategies, testing expectations. How does work get done here?

### Open Threads & Risks (~400 tokens)
Unfinished work, known risks, things that need attention soon. Helps the agent understand where the edges are and what to be careful about.

### Glossary (~500 tokens)
Project-specific terminology that an agent needs to know. Include terms that have specific meanings in this codebase that differ from general usage.

## Priority Rules
- USE THE FULL 5,000 TOKENS — sparse output at this tier is a failure
- When the vault is small: go deep on every section, explain reasoning thoroughly, include examples
- When the vault is large: recent activity (last 5-10 sessions) gets detailed treatment; older context compresses into patterns and conclusions
- Trade-offs and wisdom should GROW over time as the team learns more — these sections should get richer, not shorter
- Decisions from early in the project that are still load-bearing get preserved; decisions that were superseded get dropped or mentioned briefly
