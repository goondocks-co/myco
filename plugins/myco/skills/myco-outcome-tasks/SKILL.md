---
name: myco-outcome-tasks
description: >-
  Author and debug the tasks Myco's own agent runs. A task is one prompt with
  declared expected evidence, dispatched to a worker: no phases, no turn budget,
  no orchestrator. It declares the gate that admits it, the tools its run may
  call, its schedule if it has one, and how the server decides afterwards that
  it actually did the work. Getting those four declarations consistent is the
  whole job.
when_to_use: >-
  Use when adding a task to the catalogue, changing what a task may call,
  changing when it runs, or working out why a run never started, ended partial,
  or closed without doing anything. Also when a catalogue gate fails and the
  message names a task.
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
user-invocable: true
---

# Outcome tasks

Myco 1.4 ran a phased executor with turn budgets, per-phase model routing and resume. None of that survives. A run is **one prompt to one harness on a worker, with declared expected evidence**. Retry is the next tick. Partial writes stand and the run is marked partial.

If you are porting something that expects phases or a resume point, it does not exist. Say so rather than reintroducing it.

## The four declarations

A task is named in four places and they must agree. A gate holds each of them, so an inconsistency fails the build rather than shipping.

**1. Its admission gate.** Exactly one, and there is no default:

| Gate | Admits when |
|---|---|
| a project capability | that capability is enabled for the project |
| an embedding provider | one is configured |
| a model provider | one is configured for this task, or by default |

**A capability absent means disabled.** Projects appear the moment a member writes, with no provisioning step, so any other default would silently admit every new project to every cost-bearing task. When a run "never starts", check this first — it is almost always the answer.

**2. The tools its run may call.** A task declares its tool names, and those become the run's entire MCP surface, mapped onto operation pairs and enforced at the one chokepoint. A tool the task did not declare answers as though it does not exist.

Declaring an empty set is a real and deliberate choice: a health probe should not hold the agent's whole default surface. If your task needs three tools, declare three.

**3. Its schedule, if it has one.** Most tasks have none and run only when asked, which is not a defect. A schedule carries an interval, the power states it may run in, a per-day ceiling, and whether an overlapping run is skipped or queued.

Two subtleties worth knowing before you copy an existing entry:

- A declaration that is **switched off is absent from the clock's list** rather than visited and skipped, so it leaves no trace of having been considered.
- A schedule block sometimes exists **for the ceiling rather than the clock**: a task with no schedule has no per-day cap, so an operator's button could spend it repeatedly. Switching the schedule off while keeping its ceiling is a legitimate shape.

**4. Its run timeout, if the default is wrong.** Named tasks carry their own budget; everything else takes the dispatcher's default. That budget is also the window the run's own routes admit it inside, and the point past which the stale sweep gives up on it — so it is three things, not one.

## Close evidence

A run does not succeed by saying it succeeded. It succeeds when **the server can see the rows it owed**. Structured final output is not relied upon, because a model that reports success and wrote nothing is exactly the failure mode this design exists to catch.

So when you add a task, decide what it owes and make that checkable. A task whose evidence cannot be seen server-side has no way to fail honestly, and it will report success forever.

## Adding one

1. Add it to the admission table with its one gate. The retained-task list is derived from that table, so a task cannot be gated without being retained.
2. Declare its tools. Keep the set as small as the work allows.
3. Give it a schedule only if it should run on a clock. Consider whether you want the ceiling even when you do not want the clock.
4. Give it a timeout only if the default is wrong for its shape.
5. Give it a close rule that names evidence the server can verify.
6. Add its ledger row. The completeness gate requires one, and a surface nobody classified is a surface dropped by default rather than by decision.

## Input builders and deduplication

A task may declare a builder that assembles its prompt and, optionally, a hash of its current inputs. When a hash is declared and matches the last run's, the dispatch is skipped as unchanged.

Declaring no hash is a real choice, not an omission. A task whose run judges for itself what is worth rewriting would be refused a pass it would have skipped for free — the dedup would be more expensive than the run.

**Know that this machinery is unexercised.** One task uses a builder and it declares no hash, so nothing today exercises the unchanged path or the scheduler's skip. It still stands and is still correct. If you add a task with a hash, you are the first caller in a while: test it directly rather than trusting the surrounding coverage.

## Why a run did not do anything

In order, cheapest first:

1. **Never admitted** — the capability is off, or no provider is configured. No run row will exist.
2. **Skipped as unchanged** — only possible if the task declares an input hash.
3. **Capped** — the per-day ceiling was reached; skipped with a reason.
4. **Overlapped** — a run was already in flight and the task skips rather than queues.
5. **Ran and wrote nothing** — the run exists and closed partial or failed its close rule. This is the only one of the five that is a prompt problem, and the only one where reading the run's own record helps.

Working down that list beats reading the prompt first, because four of the five failures never reach the prompt at all.
