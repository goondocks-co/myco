# How Myco learns

Capture is the input. Myco reads your team's sessions and turns what is worth keeping into knowledge for the next agent: titled sessions, spores and a map of the repository. You can see the results under **Myco’s work** and **Knowledge**.

## What Myco produces

**Titles.** Myco gives sessions titles and summaries so you can find the work again.

**Learning.** Myco reads prompts it has not read yet and records decisions, gotchas, discoveries, trade-offs and fixes as spores. It also curates existing knowledge: a newer finding can replace an outdated spore, and several related spores can become one.

**Learning from the code.** Myco can read an established repository and its Git history to write the project's first spores. Start this when you want knowledge from work that predates session capture.

**Code map.** One map per project describes where things live and which files matter. Read it under **Knowledge › Code map**, or let an agent ask for it through Myco's tools.

Plans come from your coding agents, rather than a Myco task. Capture sends their plan files to the server, where **Knowledge › Plans** keeps them with their source sessions.

## Where the work runs

Every Myco task runs on a **registered runner**, using an agent already signed in on that machine: Claude Code, Codex, OpenCode, Cursor or Antigravity. The server holds the queue, builds the task's prompt and checks the result. The runner takes the work and drives the agent.

Signing a machine in for capture does not register a runner. Running a server does not start one either. An administrator must explicitly register a runner and approve it in the dashboard; see [Runners](runners.md). **Runners** shows registrations, contact and available agents.

Work waits when no runner can take it. If a repository task is waiting, its runner also needs to be able to check out the connected repository. **Myco’s work** shows why a run is waiting.

## When it runs

| Work | When |
|---|---|
| Titles | After a session ends, or once an unfinished session has been quiet long enough. A runner must be available. |
| Learning | Checked hourly for unread prompts in completed sessions, while **Work on a schedule** is on. |
| Learning from the code | When someone starts it. |
| Code map | When someone starts it, or on its schedule when **Update the map on its own** is on; the default interval is six hours. |

The three project switches **Context for sessions**, **Code map** and **Learning** are on by default. Learning from sessions and code needs **Learning**; maps need **Code map**. Map work and learning from code also need a connected **Repository** in **Project settings**.

Automatic learning needs **Settings › Myco’s work › Work on a schedule**, which starts off. Automatic map updates need that switch and **Update the map on its own**, which also starts off. Capturing sessions does not depend on either schedule switch. Imported session titling has its own **Title imported sessions** control.

Learning from a large initial history starts gradually: at most two automatic extraction runs a day until that initial history drains or the active window expires (14 days by default). Once that ramp ends, the default ceiling is 12 automatic learning runs a day per project, with three of those slots reserved for recent live sessions. The schedule also skips projects without eligible new material. These limits can be changed through task overrides.

Across projects, **Runs of one task at once** defaults to 2. Further work waits in the queue. See [Configuration](configuration.md) for limits, schedules and agent choices.

## Starting work yourself

Under **Myco’s work**, **Run a task** offers:

- **Learn from new sessions now**
- **Update the code map now**
- **Learn from the project's code**

Any member can start these tasks without enabling the schedule. The project switch, repository requirements and runner still apply. By default a member who is not an administrator can start each task four times in a rolling day, across all projects. Administrators have no member daily limit. The dashboard says when a member can start the task again.

## What agents get back

**At session start**, an agent gets the project id and the server's session-start instructions, when **Context for sessions** and the corresponding injection setting are on. These instructions are text an administrator writes, shared across the server's projects.

**With each prompt**, relevant spores and plans can be served within a small shared budget. Myco tracks what that session has already received. A planning prompt can also receive a reminder to save the plan. The controls are under **Settings › Myco’s work › What sessions receive**.

**Through MCP**, an agent can search project knowledge, read sessions, plans and spores, save findings and plans, and ask for the code map. See [Agent tools](agent-tools.md).
