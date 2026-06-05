# Receiving a Handoff

Goal: given a plan ID, rehydrate a fresh session from a prepared handoff and
resume the work.

## 1. Read and parse the handoff

`myco_plans({"op":"get","id":"<plan-id>"})` → in the returned `content`, find the
block between `<!-- myco-handoff:start -->` and `<!-- myco-handoff:end -->`.
Parse out:

- **Source session** (id)
- **Referenced plans** (ids)
- **Suggested skills** (names)
- **Digest** (the narrative)

If no handoff block is present, tell the user the plan has no handoff and stop.

## 2. Load the suggested skills

For each suggested skill, invoke it with the `Skill` tool. If a skill is not
available in this symbiont, note it and continue — do not fail the handoff over
a missing optional skill.

## 3. Mark referenced plans in progress

For each referenced work plan:
`myco_plans({"op":"save","id":"<plan-id>","status":"in_progress"})`.

If this *is* a dedicated handoff plan (the plan you received is itself the work
plan, tagged `handoff`), mark **it** `in_progress`.

## 4. Optional — pull broader context

Only when you need richer/broader context than the digest gives:

- `myco_cortex({"op":"digest","tier":5000})` — high-fidelity project memory.
- `myco_search({"query":"<topic from the digest>"})` — related spores/plans;
  follow each result's `retrieve` hint to read the owning entity.

Skip this for a narrow, well-scoped resume.

## 5. Summarize the landing and resume

Tell the user, in a few lines: where the prior session left off (from the
digest), which skills you loaded, which plan(s) you marked `in_progress`, and the
concrete next step you're about to take. Then continue the work.

## CLI fallback (no MCP)

```bash
myco tool call myco_plans --json --input '{"op":"get","id":"<plan-id>"}'
myco tool call myco_plans --json --input '{"op":"save","id":"<plan-id>","status":"in_progress"}'
```
