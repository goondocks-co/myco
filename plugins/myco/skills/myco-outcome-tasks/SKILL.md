---
name: myco-outcome-tasks
description: >-
  Author and debug the tasks Myco's own agent runs. A task is one prompt with
  declared expected evidence, dispatched to a runner: no phases, no turn budget,
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

A run is one prompt to one harness on a registered runner, with declared expected evidence. The Deployment owns admission, dispatch and close checks. The member captures and delivers; it schedules no agent work.

## Read the declarations before changing a task

| Concern | Canonical declaration |
|---|---|
| Admission, tools, timeout and execution policy | `packages/myco-server/src/core/task-catalogue.ts` |
| Prompt builders and input hashes | `packages/myco-server/src/core/task-inputs.ts` |
| Recurring work | `packages/myco-server/src/core/jobs.ts` |
| Accepted reports and close evidence | `packages/myco-server/src/core/run-postconditions.ts` |
| Run-scoped tool descriptions and schemas | `packages/myco-server/src/mcp/run-definitions.ts` and `packages/myco-server/src/mcp/run-surface.ts` |

Read the task's existing path through these declarations. Some work is pulled by a runner or dispatched manually; use the task's declared policy rather than assuming every task has a clock schedule or an input builder.

## Adding or changing a task

1. Declare the admission gate and use the settings module's effective capability read. Missing capability rows use their declared defaults; archived projects do not receive automatic work.
2. Declare the smallest tool allowlist that can do the work. Put a run's capabilities on its run-scoped surface. The member tool set is for symbionts using Myco.
3. Build the prompt from admitted Project material. If it declares an input hash, verify both changed and unchanged inputs against the dispatch behavior.
4. Declare recurring work through the wake registry. Check its queueing, concurrency and daily-ceiling policy; do not add a timer.
5. Set a timeout appropriate to the task. Keep tool limits, required shapes and a valid example in the tool's description and input schema, derived from enforced constants.
6. Declare close evidence the server can verify. A model saying it succeeded is not evidence that it wrote the required artifact. A refusal must name what was not saved, the actual value or offending item, and the exact next call.
7. Reconcile the architecture ledger and verify the task through its real dispatch, tool and close path.

## When a run does no work

Read the run record and its named hold or refusal before changing the prompt. Check admission, provider availability, runner availability, queue limits and schedule policy. A queued or skipped task has not reached the harness.

For a run that started, inspect the material it received, its tool refusals and its close evidence. Partial writes stand; the close result must describe what the server can prove. Fix the failing declaration or invariant at its owner.
