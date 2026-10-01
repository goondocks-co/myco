# Configuration

Myco 2.0 is configured in one place: the server's dashboard. There is nothing to edit on a laptop and no configuration command to run. Every machine, agent and teammate reads the same settings, so a change an administrator makes reaches the whole team.

## Settings

An administrator sets these under **Settings**, in five sections.

**Myco's work.** When and how much Myco works:

- **When Myco works.** Whether it works on a schedule, and how long a project counts as active. **Work on a schedule** is off on a new server, and Myco learns spores on its own only once it is on. Here too is **Title imported sessions**: whether the sessions a machine brings from its history get titles as well. New sessions are titled when they end, once a worker is running.
- **How much at once.** How many tasks run at once, how many runs of one task, and how often one task may run in an hour.
- **Which agent does the work.** The coding agent a worker tries first, and which to try next.
- **What sessions receive.** The instructions every session starts with, and how many spores and plans come with each prompt.
- **Code map.** Whether the map updates on its own, how often, and which paths it leaves out.

**Models and keys.** The model Myco's own work uses, the provider behind search, and the keys for both. A key is stored once and never shown again; work bills to whichever account the key belongs to.

**Capture and retention.** Whether a machine brings its agents' earlier sessions when it joins, and how far back. Also how long raw transcripts and task records are kept. Sessions, prompts, replies and plans are never removed.

**Backups.** How often the server backs itself up, how many copies it keeps, and how often it checks and tidies its storage. See [Self-hosting](self-hosting.md#backing-it-up).

**Sign-in and access.** Who can sign in, and where each project's access keys are.

### What Myco does in each project

A new project captures sessions, and Myco titles them. Everything else is off until an administrator turns it on, in the project's **Project settings**, under **What Myco does here**:

| Switch | What it turns on |
|---|---|
| Learning | Myco learns spores from the project's sessions and keeps them current. It can also learn from the project's code. |
| Code map | Myco keeps a map of where things live in the project's code. |
| Context for sessions | Sessions in the project get the instructions at start, and relevant spores and plans with their prompts. |

Learning from the code and building the map also need the project's **Repository** connected, and a worker that can check it out. See [How Myco learns](intelligence.md) for what each piece of work does and when it runs.

### Starting work by hand

Any member can start a task from **Myco's work** with **Run a task**. A member who is not an administrator can start each task four times in a rolling day, across every project; an administrator has no daily limit. To give members a different number for one task, an administrator sets `memberRunsPerDay` for that task under **Task overrides** in **Models and keys**. For example, `{"extract-curate": {"schedule": {"memberRunsPerDay": 10}}}` lets each member start learning ten times a day.

## What you set per machine

A machine can name extra folders where your agents keep plans, beyond the places Myco already watches. Open **My machines** from the account menu and choose **Its settings** on the machine. The machine picks up a change at its next session start.

To see what this machine is using, run this from a connected repository:

```bash
myco config get
```

It prints the server's settings, this machine's settings, and your member settings. `myco config set` refuses and points you to the dashboard, because settings belong to the server. Member settings of your own, such as a log level, are shown but not read by Myco 2.0 yet.

## Sandboxes and CI

> **Coming:** capture from a sandbox or a CI job, where no one is there to run `myco login`. It needs an invitation that names a project, and the dashboard's invitations name none yet ([#1551](https://github.com/goondocks-co/myco/issues/1551)).

One piece already works: `myco settings` prints an agent's settings with Myco's hooks in them and no sign-in, for a job to write into its sandbox. Name the agent with `--harness` and the project with `--project`:

```bash
myco settings --harness claude-code --project <project-id>
```
