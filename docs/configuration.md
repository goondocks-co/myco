# Configuration

Myco 2.0 is configured in one place: the Deployment's dashboard. There is nothing to edit on a laptop and no configuration command to run. Every machine, agent and teammate reads the same settings, so a change an administrator makes reaches the whole team.

## Settings

An administrator sets these under **Settings**, in five sections.

**Myco's work.** When and how much Myco works:

- **When Myco works.** Whether it works on a schedule, whether it works as sessions arrive, and how long a project counts as active. Scheduled work is off on a new Deployment. Here too is **Title imported sessions**: whether the sessions a machine brings from its history get titles as well. New sessions are titled when they end, once a worker is running.
- **How much at once.** How many tasks run at once, how many runs of one task, and how often one task may run in an hour.
- **Which agent does the work.** The coding agent a worker tries first, and which to try next.
- **Learning.** Whether Myco checks what it saves before it lands.
- **What sessions receive.** The instructions every session starts with, and how many spores and plans come with each prompt.
- **Code map.** Whether the map updates on its own, how often, and which paths it leaves out.

**Models and keys.** The model Myco's own work uses, the provider behind search, and the keys for both. A key is stored once and never shown again; work bills to whichever account the key belongs to.

**Capture and retention.** Whether a machine brings its agents' earlier sessions when it joins, and how far back. Also how long raw transcripts and task records are kept. Sessions, prompts, replies and plans are never removed.

**Backups.** How often the Deployment backs itself up, how many copies it keeps, and how often it checks and tidies its storage. See [Self-hosting](self-hosting.md#backing-it-up).

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

It prints the Deployment's settings, this machine's settings, and your member settings. `myco config set` refuses and points you to the dashboard, because settings belong to the Deployment. Member settings of your own, such as a log level, are shown but not read by Myco 2.0 yet.

## Sandboxes and CI

A sandbox or CI job has no one to run `myco login`. Set `MYCO_JOIN_CODE` to an invitation link that names a project, and the first agent session redeems it and captures from then on.

To write the hook settings for such an agent without signing anything in, run:

```bash
myco settings --harness claude-code --project <project-id>
```

It prints the agent's settings with Myco's hooks and no credential in them. The job supplies its credential from its environment instead: `MYCO_SERVER_URL`, `MYCO_MEMBER_TOKEN` and `MYCO_PROJECT`, or `MYCO_JOIN_CODE`.
