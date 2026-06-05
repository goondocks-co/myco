# Preparing a Handoff

Goal: compress this session's intention into a ≤1500-token digest and persist it
on a Myco plan, with the source session ID, referenced plan IDs, and suggested
skills, then hand the user the exact line to resume in their next session.

## 1. Resolve the target plan

In priority order:

1. **Explicit `[plan-id]` argument** — use it as the target.
2. **An existing plan tied to this session** — `myco_plans({"op":"list","session":"<session-id>"})`.
   If exactly one relevant plan comes back, target it. If several, ask the user
   which (or whether to create a new one).
3. **Otherwise** — create a new dedicated handoff plan (Step 4b).

## 2. Author the ≤1500-token digest

Self-compress your **live working context** — this is a manual compaction. Focus
on **intention**, the part Myco doesn't already store:

- **How we got here / what we're doing & why** — the goal and the path to it.
- **Gotchas hit** — surprises about how something actually behaves.
- **Dead ends** — approaches ruled out, and why.
- **Decisions + rationale** — choices made and the reasoning.

**Defer to the plan.** State, next-steps, and open-questions usually already live
in the plan — do not duplicate them in the digest. Carry them in the digest
**only** when you are creating a *new dedicated handoff plan* (there is no work
plan to hold them).

**Stay within ≤1500 tokens** (~1100 words). Prefer dense prose over exhaustive
detail; the receiver can pull more via `myco_search` / `myco_cortex`.

**Secret nudge:** don't inline secrets, keys, or PII — reference them by location
(e.g. "API key in `.myco/secrets.env`").

## 3. Choose suggested skills

Decide which skills the receiver will need to resume well. Always include `myco`.
Add domain skills relevant to the work (e.g. a debugging or subsystem skill).
List them by name.

## 4. Persist the handoff block

Assemble the block:

```markdown
<!-- myco-handoff:start -->
## Handoff — <today's date YYYY-MM-DD>
- **Source session:** <this session id>
- **Referenced plans:** <plan-id>, <plan-id>
- **Suggested skills:** myco, <skill>, <skill>

### Digest
<the digest from step 2>
<!-- myco-handoff:end -->
```

### 4a. Append/replace onto an existing plan (idempotent)

1. Read current content: `myco_plans({"op":"get","id":"<plan-id>"})`.
2. If a `<!-- myco-handoff:start -->…<!-- myco-handoff:end -->` block already
   exists, **replace** it with the new block. Otherwise append the new block to
   the end. Leave all other plan content untouched.
3. Save: `myco_plans({"op":"save","id":"<plan-id>","content":"<full updated content>"})`.
   (Updating by `id` preserves the plan's existing status.)

### 4b. Create a new dedicated handoff plan

```json
myco_plans({
  "op":"save",
  "session_id":"<this session id>",
  "title":"Handoff: <short topic>",
  "status":"active",
  "tags":["handoff"],
  "content":"<the handoff block>"
})
```

The `save` response returns the new plan `id` — capture it for Step 5.

## 5. Return the resume instruction to the user

Tell the user the plan ID and the **exact line** to run next session, plus a
one-line summary of what was captured. For example:

> Handoff saved to plan `<plan-id>`. In your next session, run:
> `/myco-handoff receive <plan-id>`
> It carries: <one-line summary of the digest + referenced plans + suggested skills>.

## CLI fallback (no MCP)

```bash
myco tool call myco_plans --json --input '{"op":"list","session":"<session-id>"}'
myco tool call myco_plans --json --input '{"op":"save","id":"<plan-id>","content":"..."}'
```
