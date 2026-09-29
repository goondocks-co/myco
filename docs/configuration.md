# Configuration

Myco 2.0 is configured in one place: the Deployment's dashboard. There is nothing to edit on a laptop and no configuration command to run. Every machine, agent and teammate reads the same settings, so a change an administrator makes reaches the whole team.

## What you set on the Deployment

An administrator sets these on the dashboard's **Settings** page:

- **The agent.** Which model provider does Myco's intelligence work, and the credentials it uses.
- **Scheduling.** Whether Myco's work runs on a schedule, and whether it runs as sessions are captured. Scheduled work is off on a new Deployment. Session titles and summaries follow each session either way, once a worker is running.
- **Limits.** How many runs may happen at once, and how often one task may run.
- **What sessions receive.** The text every agent session starts with, and how many spores come with each prompt.
- **Code map.** How the repository map is built.
- **Embedding.** The provider behind semantic search.
- **Workers.** Which coding agent a worker uses to run Myco's tasks, and which to fall back to.
- **Backup and maintenance.** When the Deployment backs itself up and checks and tidies its storage.
- **Importing past sessions.** Whether a machine brings its agents' earlier sessions when it joins, and how far back.
- **Projects.** What Myco does for each project. See the next section.

### Turn on what each project gets

A new project captures sessions and nothing more until an administrator turns on its capabilities, under **Projects** in Settings. Each one is off until you turn it on.

| Capability | What it turns on |
|---|---|
| Vault evolution | Myco reads new sessions and turns them into spores, and seeds a new project from its repository. |
| Canopy | The repository map agents can ask for. |
| Cortex | Context delivered to agents: the session-start text, and relevant spores with each prompt. |

Seeding a project and building its map also need the project's repository connected, and a worker that can check it out. See [How Myco learns](intelligence.md) for what each piece of work does and when it runs.

## What you set per machine

A machine can name extra folders where your agents keep plans, beyond the places Myco already watches. An administrator sets them for their own machine on the dashboard's **Members** page. The machine picks up a change at its next session start.

To see what this machine is using, run this from a connected project:

```bash
myco config get
```

It prints the Deployment's settings, this machine's settings, and your member settings. `myco config set` refuses and points you to the dashboard, because settings belong to the Deployment.

## What is not configurable yet

Member settings, such as a log level or an update channel of your own, are shown by `myco config get` but not yet honoured. See [Known gaps](quickstart.md#known-gaps).

## Sandboxes and CI

A sandbox or CI job has no one to run `myco login`. Set `MYCO_JOIN_CODE` to an invitation link that names a project, and the first agent session redeems it and captures from then on.

To write the hook settings for such an agent without signing anything in, run:

```bash
myco settings --harness claude-code --project <project-id>
```

It prints the agent's settings with Myco's hooks and no credential in them. The job supplies its credential from its environment instead: `MYCO_SERVER_URL`, `MYCO_MEMBER_TOKEN` and `MYCO_PROJECT`, or `MYCO_JOIN_CODE`.
