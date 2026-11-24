# Configuration

An administrator changes server settings in the dashboard. Each member sets their own machine's capture folders there too. Changes apply through the server; you do not need to hand-edit a configuration file on every laptop.

## Settings

**Settings** has six sections for the whole server.

### Myco’s work

- **When Myco works** controls **Work on a schedule**, how long projects count as active, and when a quiet session is ready for a title. Scheduled work starts off. **Title imported sessions** separately enables titling older sessions.
- **How much at once** controls **Tasks at once**, **Runs of one task at once** and **Runs of one task per hour**. The default for runs of one task at once is **2 across all projects**. Further runs queue. Clear an override to restore the default, or choose **No limit**.
- **What sessions receive** controls **Session-start instructions**, injection at session or subagent start, spores and plans with prompts, and the planning reminder. The instructions are one shared template for all projects, up to 4 KB. **Items per prompt** shares its count between spores and plans; a 300-token budget can serve fewer.
- **Code map** controls **Update every** and **Paths left out**. Projects with Code map on keep their map current after new capture, including during active work; the default interval is six hours. Automatic updates need scheduled work, a connected repository and a ready runner, and task limits apply.

First extraction of a large history ramps at two automatic runs a day until the initial history drains or the active window expires. The normal automatic ceiling is 12 learning runs per project per day, with three slots reserved for recent live sessions. [How Myco learns](how-myco-learns.md) explains the four kinds of work.

### Models

Two decisions, then Advanced.

**Quick jobs** (session titles and summaries) are **Answered by** one of the answerers this server offers: Cloudflare's included model on a Cloudflare server, **My own model address** (any OpenAI-compatible address, its model name and an optional key), or, on a local server, **A runner's agent**. The words under the choice say what it costs and needs.

**Work that needs an agent** is three steps. **Agent** picks the coding agent runners try first, from the agents your registered runners offer, or **No preference**, where each runner uses the first agent it is signed in to; the line under it says which agent each runner uses today. **Paid by** sets, in one change on every runner offering that agent, whether it pays with **each runner's own sign-in** (the default) or **a stored key**; every runner changes or none does, and one line per runner says what it uses now. Choosing a stored key when none is usable saves nothing and offers to add one. A stored Claude Code value says whether it is a subscription token or an API key (billed to the API account, including any monthly credit). If a chosen stored key stops working, the work waits; it never falls back to a runner's own sign-in. **Check** asks whether learning from sessions could start now, by the same rules a runner's claim follows, the daily work budget included, and names the runner that would take it or the one thing in the way.

**Advanced** folds away the model each agent uses for small, medium and large jobs (one group per agent a runner offers, or whose sizes were changed), **Size of each job**, **Agents tried next**, **Overrides for each task** and **Search by meaning**, each with a line saying whether it was changed. Unset Codex or OpenCode models hold that work until configured. **Overrides for each task** can choose a different agent, size, model, effort or schedule for one task; a model named there needs an agent beside it. **Search by meaning** sets the embedding provider and model; Cloudflare servers default to Workers AI, a local server matches words until one is configured, and changing the model rebuilds search in the background while it stays available.

Runners use agents already signed in on their machines. Registering a runner is separate from member sign-in; choosing an agent does not register one.

### Connections

One list of everything Myco holds a credential for: **GitHub** (this server's App, with its setup checklist under it and **Test** to check it again), each stored model key, and each telemetry key. Each row says what it is for, whether it works and since when, and its actions. **Add a connection** first asks what kind (a model key, a launcher that reports activity, or an agent that reads one project from outside) and then shows only that kind's fields. A telemetry key's row shows how a launcher uses it; see [Telemetry from a launcher](agents.md#telemetry-from-a-launcher-opentelemetry).

### Capture and retention

**New repositories › Create a project for it** controls whether a repository inside a machine's capture folders can create a project when none holds its remote. If off, it waits for an administrator to connect it. Repositories whose remote already belongs to a project can still join that project.

**Importing past sessions** controls **Import past sessions on join**, how far back to reach and how many sessions to bring per agent. Turning import off also refuses manual import.

**What Myco keeps** controls raw content and task record retention. **Keep raw content hot for** defaults to 90 days; older raw bytes move into verified archive storage. Sessions, prompts, replies, tool calls, plans and spores stay indefinitely.

### Backups

**Backups** controls the interval and retained recovery copies. A local server writes verified recovery copies; a Cloudflare server stages a copy for an operator to complete. **Store checks** controls automatic optimization and integrity checks. Their results appear on **Health**. For operator commands, see [Run your own Myco](self-hosting.md).

### Sign-in and access

This section points to **People & machines** for membership and machine access, and **Project settings › Access keys** for external agents. Keys are scoped to one project; see [External agents](external-agents.md).

## What Myco does in each project

An administrator changes these in **Project settings › What Myco does here**. All three switches are **on by default**; an explicit opt-out stays off.

| Switch | What it enables |
|---|---|
| Context for sessions | Session-start instructions and relevant spores and plans with prompts, subject to the server's injection settings. |
| Code map | A map of where things live in the project's code. |
| Learning | Learning spores from sessions, curating existing spores and learning from code. |

Map work and learning from code need **Project settings › Repository** connected. Agent work needs a registered runner. Scheduled work needs its separate server switches. Archived projects are excluded from automatic work.

## Starting work by hand

Every member can use **Myco’s work › Run a task**. By default a member who is not an administrator can start each task four times in a rolling day, across all projects. Administrators have no member daily limit.

To change that allowance for one task, set `memberRunsPerDay` in **Models › Advanced › Overrides for each task**. For example:

```json
{"extract-curate": {"schedule": {"memberRunsPerDay": 10}}}
```

This gives each member ten manual learning starts a day. It is separate from the automatic schedule's daily ceiling. Concurrency limits queue work; reaching a member daily ceiling refuses another start until the allowance returns.

## What you set per machine

Open **My machines** from the account menu and choose **Its settings**:

- **Folders it captures** names parent folders whose Git repositories join automatically; the default is `~/Repos`.
- **Extra plan folders** adds plan locations beside each agent's own plan folder. Entries may be relative to a project, start with `~/`, or be absolute.

Only the member who owns a machine can change its settings. A change is picked up at that machine's next session start. For a repository outside the capture folders, run `myco member join` from that repository.

To inspect effective settings from a connected repository:

```bash
myco config get
```

It shows server, machine and member settings. The configuration CLI is read-only in member mode; use the dashboard to change settings. Personal settings such as a log level may be shown without being consumed by the 2.0 runtime.

## Sandboxes and CI

Generated hooks do not sign a sandbox or CI job in.

One piece already works: generate an agent's settings with Myco's hooks, without signing in, for a job to write into its sandbox:

```bash
myco settings --harness claude-code --project <project-id>
```
