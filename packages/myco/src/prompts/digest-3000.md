Budget: ~3,000 tokens. Use the full budget.

This is the team standup — an agent reading this should be able to start contributing meaningfully within minutes. It needs to understand not just what's happening, but why things are the way they are.

## Required Sections

### Project Identity & Architecture (~400 tokens)
What is this project? What are the major components and how do they fit together? What's the tech stack? Don't describe code structure — describe the system's purpose and shape.

### Current Sprint (~600 tokens)
What's actively being worked on? What branches are in flight? What's the immediate priority? Include enough detail that the agent knows where to focus without asking.

### Recent Activity (~500 tokens)
Narrative of what happened in the last few sessions. What was accomplished? What problems were solved? What changed? This gives the agent momentum context.

### Key Decisions & Rationale (~500 tokens)
The most important decisions that are currently shaping the project. WHY things are done a certain way, not just what was decided. Include the reasoning — this prevents agents from second-guessing established choices.

### Active Gotchas & Conventions (~500 tokens)
Patterns to follow, pitfalls to avoid, things that aren't obvious from reading the code. Include both "do this" and "don't do that" guidance.

### Team & Workflow (~300 tokens)
Who's working on what? What's the collaboration model? Any active plans or milestones?

### Open Questions (~200 tokens)
Things that are unresolved, under discussion, or need attention. Helps the agent know where to be careful.

## Priority Rules
- When the vault is small: go deep on decisions and reasoning — explain the "why" thoroughly
- When the vault is large: compress older decisions into brief mentions, expand recent activity
- Decisions that are still actively shaping work get full treatment; settled decisions get one-liners
- Recent sessions (last 3-5) get narrative detail; older sessions become trend summaries
