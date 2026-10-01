# How Myco learns

Capture is only the input. What makes Myco worth running is what happens after a session ends. Myco reads what your agents did and turns it into knowledge the next agent starts with: titled sessions, spores, and a map of the repository. It then hands that knowledge back to every agent on the team.

## What Myco produces

**Session titles and summaries.** When a session ends, Myco gives it a title and a summary, so the history reads as a list of what was done rather than a list of ids.

**Spores.** Myco reads the prompts it has not read yet and records what is worth keeping as spores: decisions, gotchas, discoveries, trade-offs, fixes. It also curates what is already there. A spore the code has moved past is superseded by a newer one, and several spores saying the same thing are consolidated into one. The project's knowledge stays current rather than only growing.

**Learning from the code.** When you bring an established codebase to Myco, it can read the code and its git history and write the project's first spores, so the team does not start from nothing.

**The code map.** One map per project gives an agent the directory layout and the files that matter, so it can orient itself in a single call. It is on the dashboard under **Knowledge** too.

**Plans** come straight from capture. When an agent writes a plan, its hooks send the plan file along with the turn.

## Where the work runs

Myco's work runs on a **worker**: a coding agent you already use, such as Claude Code, Codex, OpenCode, Cursor or Antigravity, driven by the `myco` binary on an administrator's machine. The Deployment keeps the queue and decides which agent each task uses (see [Configuration](configuration.md)). The worker takes a task, runs it, and the Deployment checks the result before counting the task done.

- A laptop Deployment started with `myco server run` or `myco server install` runs its own worker.
- On any other Deployment, an administrator's machine runs the worker. `myco login` sets it up for an administrator, and it starts whenever they log in.
- `myco worker status` shows whether this machine's worker is installed and running.

Only an administrator's machine runs work. A member's machine captures and reads, and runs nothing on the Deployment's behalf. Work waits in the queue until a worker takes it; nothing is refused because no worker happened to be free. **Health** shows which machines run work, and when each last checked in.

## When it runs

| Work | When |
|---|---|
| Titles and summaries | After each session ends. |
| Spores | Every hour while there are prompts it has not read, when scheduled work is on. |
| Learning from the code | When someone starts it. |
| The code map | When someone starts it, or on its own if **Update the map on its own** is turned on. |

Each project chooses what it gets. Spores and learning from the code need the project's **Learning** switch, and the map needs **Code map**. Both are off for a new project until an administrator turns them on. Learning from the code and the map also need the project's repository connected, and a worker that can check it out. See [Configuration](configuration.md).

## Starting work yourself

You don't have to wait for the schedule. On the dashboard's **Myco's work** page, **Run a task** starts one of three tasks in a project now: **Learn from new sessions now**, **Update the code map now**, or **Learn from the project's code**. Any member can start them. A member who is not an administrator can start each one four times in a rolling day; an administrator has no daily limit. The run goes to the same queue as the rest of Myco's work, and **Myco's work** shows what it came to.

## What agents get back

**At session start** an agent gets its project's id and, if the project has **Context for sessions** on, the Deployment's session-start instructions.

**With each prompt** it gets the relevant spores it has not seen yet in that session. They come in a small budget, so they help without crowding the prompt. When the prompt talks about planning, it also gets a reminder to save the plan.

**Through MCP** it can search everything the project knows, read sessions, plans and spores, save plans and spores of its own, and ask for the code map. See [Agent tools](agent-tools.md).
