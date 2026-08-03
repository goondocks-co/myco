# Grove Management

A **Grove** is the local home for one or more projects. It gives related projects a shared vault, shared provider settings, shared backups, and an optional Team Host connection while still letting each project keep its own identity.

Most users start with the default Grove Myco creates during install. Create more Groves when you want to separate workstreams, clients, experiments, or teams.

## When to Use More Than One Grove

Keep projects in the same Grove when they should share project knowledge, provider setup, backups, and Team Host connection. This is common for a monorepo, a product plus companion tooling, or several repos that one team works on together.

Use separate Groves when projects should stay independent. Good reasons include client separation, personal versus work projects, risky experiments, or projects that shouldn't route through the same Team Host.

The Grove boundary matters because search, embeddings, backups, and Team Host connections are organized around it.

## How Projects Join a Grove

After install, Myco creates a default Grove. The first time you use a supported coding agent from a git repository, Myco registers that project into the default Grove and starts capture.

Projects only register from git repositories. If you work in a folder that is not a git repo, Myco leaves it alone.

To share a project identity with teammates, commit `.myco/project.toml`. Myco creates this file automatically and tracks it in git. Teammates who clone the repo can land in the same project identity while keeping their own local Grove data and settings.

## Manage Groves in the Dashboard

Open the dashboard:

```bash
myco open
```

Use the **Groves** page to:

- Create a new Grove
- Rename a Grove
- Set the default Grove
- Move a project to another Grove
- Back up a project
- Archive or unarchive a project
- Ignore a project so Myco stops bringing it back automatically
- Delete a project after confirmation
- Delete an empty Grove

The **Grove** dashboard shows the selected Grove's projects, recent activity, vault health, backups, and nearby Groves.

## Project Capabilities

Each project can run as capture-only or enable deeper intelligence features. On the **Groves** page, each project row shows capability badges. Click the badges to open the project capability panel.

The available capabilities are:

| Capability | What it enables |
| --- | --- |
| **Cortex** | Project briefings and generated instructions that help connected agents start with the right context. |
| **Canopy** | Codebase awareness, file summaries, project maps, and supported pre-read context. |
| **Skills** | Skill candidate discovery, skill generation, and skill evolution. |
| **Vault Evolution** | The main background intelligence pass that processes captured sessions into spores, summaries, wisdom, and digests. |

When all four capabilities are off, the project is **Capture-only**. Myco still records sessions, keeps them searchable, and exposes the project through local tools, while the heavier background intelligence work stays quiet.

Capability toggles on the Groves page apply at **Personal** scope. They affect this machine only. This lets you pause heavier intelligence work locally without changing the team's shared project defaults.

## Scheduling and Capabilities

Scheduled tasks follow project capabilities. If a capability is off, tasks governed by that capability do not run even if their individual schedule is enabled.

For example:

- Turning off **Vault Evolution** stops the scheduled `vault-evolve` task.
- Turning off **Canopy** stops scheduled Canopy map and description refreshes.
- Turning off **Skills** stops skill survey, generation, and evolution tasks.
- Turning off **Cortex** stops scheduled Cortex instruction refresh.

You can still tune individual task schedules from the **Agent** page. The task page shows the effective schedule state so you can see whether a task is active or held off by a project capability.

## Capture-only Projects

Capture-only is useful when you want Myco to remember sessions without spending tokens or local compute on deeper processing. Use it for:

- Repos you visit occasionally
- Experiments you do not want in the intelligence pipeline yet
- Projects where you only want search and session history
- Temporary worktrees or scratch projects

You can promote a capture-only project later by opening its capability panel and enabling the features you want.

## Moving and Archiving Projects

Move a project when it belongs with a different set of Grove settings or a different Team Host connection. Myco keeps the project identity intact and shows the project under the target Grove after the move.

Archive a project when you want it out of the active list but may need it later. Archived projects can be shown and unarchived from the Groves page.

Ignore a project when you want Myco to stop automatically bringing it back after removal or cleanup.

## Backups and Deletes

Backups are Grove-scoped. You can run a project backup from the Groves page, and Myco runs local backups automatically during idle periods when backups are enabled.

Deleting a project is destructive and requires confirmation. When backups are enabled, Myco creates a fresh backup before destructive project deletion.

## Team Host

Connecting a project to a Team Host moves its knowledge to a teammate's Myco, which holds the single copy while the project is connected — the team and non-member agents query it there, and disconnecting brings the history back. For projects not connected to a host, local Grove data remains the source of truth.

Use the **Team** page to host a team or join one, and to connect projects to a host. See [Team Host](team-host.md) for the full guide.

## Troubleshooting

If a project does not appear in the Groves page, start a supported coding agent from that git repository and run a normal session. Myco registers projects when supported agents work inside them.

If a project appears when you expected it to stay removed, archive or ignore it from the Groves page.

If scheduled work is not running, check both places:

- The project capability badges on the **Groves** page
- The task schedule on the **Agent** page

Run `myco doctor` when the dashboard, service, or provider setup looks unhealthy.
