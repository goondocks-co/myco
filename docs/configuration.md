# Configuration

An administrator changes server settings in the dashboard. Each member sets their own machine's capture folders there too. Changes apply through the server; you do not need to hand-edit a configuration file on every laptop.

## Settings

**Settings** has six sections for the whole server. The first five hold the few things an administrator decides; everything else is under **Advanced**, with defaults that work untouched.

### Myco’s work

**Should Myco work on its own?** holds **Work on its own** and the **Daily budget**, each saying who changed it and when; the budget also says what was spent in the last 24 hours. Work on its own starts off. Work started by hand is never held by the budget, and its spend counts.

**Where the work runs** lists each registered runner: what it last ran and when, how it pays for the agent it uses, whether it is online, and **Manage**, which opens that runner's page. **Add a runner** shows the commands to run on the new machine.

### People and machines

**Who can sign in?** lists each person with their role, how they sign in and how many machines write for them; **Manage** holds connecting their GitHub account, adding a machine for them, changing their role and removing them, and **Invite a teammate** adds someone. **Open invitations** lists links nobody has used yet. **Machines** lists every machine (a member sees their own): what each captures, whether it is also a runner, and what it is doing, with **Manage** opening the machine's page and former machines folded below; **Add a machine** makes a sign-in link. **Myco’s run sign-ins** lists the sign-ins Myco's runs used. Transferring ownership and claiming raw data with no recorded uploader are under **Advanced › Owner actions**.

### Repositories

**What can Myco read?** is one row for this server's GitHub App: which App it is, who owns it, which accounts it is installed on and whether it works, with **Test** and **Install on another account**. Until every setup step is done, the setup checklist is open under the row; afterwards it stays folded there with the accounts approved here.

**Projects and their repositories** lists every live project, most recently active first, with its repository and branch, or **Connect**, which opens that project's **Repository** setting. The first five show; **Show all** shows the rest. Where projects have no repository, Myco can propose the repository named like each one.

### Models

Two decisions, then search.

**Quick jobs** (session titles and summaries) are **Answered by** one of the answerers this server offers: Cloudflare's included model on a Cloudflare server, **My own model address** (any OpenAI-compatible address, its model name and an optional key), or, on a local server, **A runner's agent**. The words under the choice say what it costs and needs.

**Work that needs an agent** is three steps. **Agent** picks the coding agent runners try first, from the agents your registered runners offer, or **No preference**, where each runner uses the first agent it is signed in to; the line under it says which agent each runner uses today. **Paid by** sets, in one change on every runner offering that agent, whether it pays with **each runner's own sign-in** (the default) or **a stored key**; every runner changes or none does, and one line per runner says what it uses now. Choosing a stored key when none is usable saves nothing and offers to add one. A stored Claude Code value says whether it is a subscription token or an API key (billed to the API account, including any monthly credit). If a chosen stored key stops working, the work waits; it never falls back to a runner's own sign-in. **Check** asks whether learning from sessions could start now, by the same rules a runner's claim follows, the daily work budget included, and names the runner that would take it or the one thing in the way.

**Search** sets the embedding provider and model that finding things by meaning reads with. Cloudflare servers default to Workers AI, a local server matches words until one is configured, and changing the model rebuilds search in the background while it stays available. The model each agent uses for small, medium and large jobs is under **Advanced › Model sizes**.

Runners use agents already signed in on their machines. Registering a runner is separate from member sign-in; choosing an agent does not register one.

### Connections

One list of everything Myco holds a credential for: **GitHub** (whether this server's App works, **Test**, and a link to **Repositories**, where it is set up), each stored model key, and each telemetry key. Each row says what it is for, whether it works and since when, and its actions. **Add a connection** first asks what kind (a model key, a launcher that reports activity, or an agent that reads one project from outside) and then shows only that kind's fields. A telemetry key's row shows how a launcher uses it; see [Telemetry from a launcher](agents.md#telemetry-from-a-launcher-opentelemetry).

### Advanced

Seven folded groups, each with one line on what it holds and whether anything in it was changed, by whom and when. A link to a group, or to a setting inside one, opens it.

- **Model sizes**: the model and effort each agent a runner offers uses for small, medium and large jobs, **Size of each job**, **Agents tried next** and **Overrides for each task**. Unset Codex or OpenCode models hold that work until configured. **Overrides for each task** can choose a different agent, size, model, effort or schedule for one task; a model named there needs an agent beside it.
- **Pace**: how long projects count as active, when a quiet session is ready for a title, how often release tracking checks what shipped; **Tasks at once**, **Runs of one task at once** (2 across all projects by default) and **Runs of one task per hour**, where further runs queue; and the code map's **Update every** and **Paths left out**. Automatic code map updates need Myco to work on its own, a connected repository and a ready runner.
- **What sessions are given**: **Session-start instructions** (one shared template, up to 4 KB), injection at session or subagent start, spores and plans with prompts, and the planning reminder. **Items per prompt** shares its count between spores and plans; a 300-token budget can serve fewer.
- **New repositories and past sessions**: **Create a project for it** (whether a repository inside a machine's capture folders gets a project when none holds its remote; off, it waits for an administrator), **Importing past sessions** (turning it off also refuses manual import) and **Title imported sessions**.
- **How long things are kept**: **Keep raw transcripts in active storage for** (90 days by default; older raw transcripts move into verified archive storage) and how long task records are kept. Sessions, prompts, replies, tool calls, plans and spores stay indefinitely.
- **Backups**: the interval and retained recovery copies, and **Store checks** (automatic optimization and integrity checks, whose results appear on **Health**). A local server writes verified recovery copies while it keeps serving; on a Cloudflare server a scheduled backup pauses the dashboard while it runs, so automatic backups start off there. For operator commands, see [Run your own Myco](self-hosting.md).
- **Owner actions**: transferring ownership of the server, and, for the owner, claiming raw data with no recorded uploader.

Access keys for external agents are in each project's settings; see [External agents](external-agents.md).

First extraction of a large history ramps at two automatic runs a day until the initial history drains or the active window expires. The normal automatic ceiling is 12 learning runs per project per day, with three slots reserved for recent live sessions. [How Myco learns](how-myco-learns.md) explains the four kinds of work.

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

Open **Settings › People and machines**, choose **Manage** on the machine, and choose **Change folders**:

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
