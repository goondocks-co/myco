# Rules File — Bad Example

This is an example of a poorly written CLAUDE.md. Every section contains anti-patterns that cause agents to freestyle, skip rules, or misinterpret intent. Each problem is annotated below.

---

# Patchwork

A deployment tool. Use best practices and write clean code.

Try to follow SOLID principles and keep things simple. Use TypeScript patterns when appropriate.
We want good test coverage. Avoid hardcoded values when possible.

Architecture:

- Routes
- Services
- Database

When adding features, follow the existing patterns and make sure things work.
Try to add tests for important functionality. Keep the codebase clean.

---

## What's Wrong (and How Agents Exploit It)

### 1. "Use best practices" — vague and unenforceable

**Problem:** Every agent interprets "best practices" differently. One agent adds dependency injection, another uses functional patterns, a third invents its own service layer.

**Why agents exploit it:** It's permission to do whatever they think is best. They always think their approach is a best practice.

**Fix:** Specify the practice. "All request input MUST be validated with Zod schemas in `src/schemas/`."

### 2. No non-goals — unlimited scope

**Problem:** Without explicit boundaries, agents will "improve" anything they touch. They'll add caching layers, restructure folders, create abstraction hierarchies — all unrequested.

**Why agents exploit it:** Agents default to being helpful. Without boundaries, everything looks like an opportunity to improve.

**Fix:** Add explicit non-goals: "Patchwork is NOT a deployment orchestrator, NOT a monitoring system, NOT a CI/CD pipeline."

### 3. "When appropriate" and "when possible" — loophole generators

**Problem:** "Use TypeScript patterns when appropriate" and "avoid hardcoded values when possible" give agents a built-in excuse to skip the rule. They'll decide it's "not appropriate" or "not possible" whenever the rule is inconvenient.

**Why agents exploit it:** The qualifying phrase is a release valve. Agents will always find a reason the exception applies.

**Fix:** Make it absolute or define the exceptions: "No literal strings or numbers outside of `src/constants.ts`. Exception: test fixture data in `tests/fixtures/`."

### 4. No anchors — agents invent patterns

**Problem:** "Follow existing patterns" doesn't say which patterns or where to find them. Agents scan the codebase, find three different approaches, and pick whichever they prefer — or invent a fourth.

**Why agents exploit it:** Without a canonical example to copy, agents rely on their training data, which includes thousands of different patterns.

**Fix:** Point to specific files: "Copy `src/routes/patches.ts` for new endpoints."

### 5. "Try to add tests" — permission to skip

**Problem:** "Try to" means "do it if you feel like it." Agents will skip tests for "simple changes" or "obvious code."

**Why agents exploit it:** Agents optimize for speed. If tests are optional, they're the first thing cut.

**Fix:** Make it a gate: "ALL changes MUST include tests. Run `npm test` before committing."

### 6. "Keep things clean" — means nothing

**Problem:** What does "clean" mean? Short functions? No comments? Lots of comments? Alphabetized imports? Every agent has a different opinion.

**Why agents exploit it:** It's a vibes-based instruction. Agents will refactor code to match their idea of "clean," often introducing unnecessary changes.

**Fix:** Be specific about what clean means in this project: "Functions MUST NOT exceed 50 lines. Files MUST NOT exceed 300 lines. Imports MUST be grouped: node: built-ins, external packages, internal modules."

### 7. Architecture section is just labels

**Problem:** "Routes, Services, Database" describes what exists but says nothing about the rules. Can a route call the database directly? Can a service import from routes? Who knows.

**Why agents exploit it:** Without layering rules, agents take the shortest path. If the database is faster to call from a route, they'll do it.

**Fix:** Define the invariants: "Route handlers delegate to services. Services MUST NOT import from routes. Database access MUST go through `src/db/client.ts`."

### 8. No quality gates — "make sure things work" is not a gate

**Problem:** "Make sure things work" has no verification step. There's no command to run, no coverage threshold, no lint check.

**Why agents exploit it:** If there's no specific command to run, agents won't run anything. They'll eyeball the code and claim it works.

**Fix:** List exact commands: "`npm run lint && npm run typecheck && npm test` — ALL must pass before committing."

---

## The Pattern

Bad rules files share these characteristics:

| Anti-Pattern | Example | Why Agents Exploit It |
|-------------|---------|----------------------|
| Vague verbs | "should", "try to", "prefer" | Not enforceable — agents treat them as suggestions |
| No examples | "follow good patterns" | Agents invent patterns from training data |
| No metrics | "keep coverage high" | Subjective — agents set their own threshold (usually 0%) |
| Loopholes | "when possible", "if needed" | Built-in excuse to skip the rule |
| Missing scope | (no non-goals section) | Agents "improve" everything they touch |
| No gates | "add tests" | No way to verify compliance |
| Just labels | "Routes, Services, Database" | Describes structure without enforcing rules about it |
| Aspirational | "keep things clean" | Means whatever the agent wants it to mean |
