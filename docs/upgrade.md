# Upgrading Myco

Myco keeps itself up to date. It's a self-contained native binary, and the local service self-updates from your release channel in the background while it's idle — no command to run, no Node required. The binary carries the CLI, local service, dashboard, agent connections, and built-in intelligence features.

## TL;DR

Nothing to do — Myco upgrades itself automatically. When you want to take an update now rather than wait for the idle self-update, open the **Upgrade** section of the dashboard's **Settings** page and click **Upgrade & Restart**.

For advanced or scripted use, a CLI is available:

```bash
myco upgrade                  # upgrade on the current channel
myco upgrade --channel beta   # switch to and upgrade on the beta channel
```

The dashboard is Myco's primary interface; the CLI is for bootstrap and advanced use.

## What the upgrade does

When Myco self-updates (automatically, from the Settings page's Upgrade section, or via `myco upgrade`):

1. **Updates Myco's local service and dashboard** to the new version.
2. **Refreshes supported agent connections** while preserving settings you already had in those agents.
3. **Archives Myco-owned files from older per-project installs** instead of deleting them.
4. **Keeps registered Groves and projects intact** and reports anything that needs attention through the dashboard and `myco doctor`.

Project registration continues automatically as you use supported agents from git projects.

## v1.0: agent and embedding settings now live in the Grove

Myco v1.0 makes agent and embedding configuration **Grove-scoped** — one setting shared by every project in a Grove, instead of a separate copy in each project's `myco.yaml`.

**Breaking change.** On the first restart after upgrading to v1.0, Myco removes agent and embedding settings from every project's `myco.yaml` and resets those projects to the Grove's configuration. The fields reset are the agent provider, harness, model, per-task overrides, the scheduling toggles, and the embedding provider, model, and base URL.

Most projects carried these values only because older Myco wrote them per-project, so the Grove already holds the same configuration and the reset changes nothing you can observe. If a project ran a genuinely different agent or embedding setup, reconfigure it at the **Grove** scope from the dashboard's **Settings** page after the upgrade.

Need a per-project value for a specific field? Use the scope pill on that field in the dashboard to opt it back to project scope. Layering is opt-in per field — nothing is project-scoped by default.

The previous values are not lost: the pre-upgrade `myco.yaml` is in your git history, and Myco archives older Myco-owned files rather than deleting them.

## From v0.25.x or earlier (per-project install era)

If you previously had per-project `.agents/` installs:

1. Let Myco self-update, or trigger **Upgrade & Restart** from the Settings page's Upgrade section.
2. Myco archives older Myco-owned per-project files in place.
3. Per-project overrides now live in the dashboard's **Symbionts** page. You can disable a symbiont in a specific project from there.

After the upgrade, verify with `myco doctor`. It reports anything Myco could not update automatically.

## From per-machine MIT-era installs

The license changed from MIT to Apache 2.0 on 2026-04-29 (commit `57a9571a`). No code action required, but if your team's compliance review tracks license metadata, re-acknowledge.

## Optional operator packages

If you also installed one of the standalone operator CLIs, they upgrade independently. The Upgrade section of the dashboard's Settings page detects updates for them too and offers a one-click apply.

```bash
npm update -g @goondocks/myco-team       # team-sync operator CLI
npm update -g @goondocks/myco-collective # Collective operator CLI
```

Most users never need these.

## Verifying the upgrade

After Myco restarts:

```bash
myco doctor
```

Doctor checks your local Myco install, Grove data, providers, connected agents, service status, and dashboard access. Use `--fix` to auto-repair fixable issues.

The dashboard's **Symbionts** page shows the live install state for every detected agent and offers a re-detect trigger if anything looks off.

## Contributor dogfood installs

Contributors can run a development Myco service alongside the production install. Production upgrades do not take over development Groves, and development restarts do not disturb the production service.

See [Lifecycle](lifecycle.md) for the contributor workflow.

## Rollback

Myco archives older Myco-owned per-project files rather than deleting them. The self-updater also keeps the previously installed binary, so if an update misbehaves Myco can fall back to the prior version. To pin a specific release line, use the **Stable** / **Beta** channel toggle in the Settings page's Upgrade section — see [Lifecycle](lifecycle.md) for how channels work.

If you want to remove Myco entirely:

```bash
myco remove           # remove Myco's contributions from every agent's global config
myco remove --purge   # additionally remove ~/.myco/ itself
```

Removal preserves user-pre-existing keys in shared agent config files.

## Common failure modes

### Myco didn't pick up the new version

The self-updater applies an update and restarts the service on the next idle window. To take it immediately, click **Upgrade & Restart** in the Settings page's Upgrade section, or run `myco restart` after `myco upgrade`.

### Dashboard shows "Connecting to Myco..."

Hard-reload the tab (Cmd+Shift+R / Ctrl+Shift+R), then run:

```bash
myco open
myco doctor
```

### A connected agent is not capturing in a new worktree

Open the dashboard's Symbionts page and trigger re-detect. If you committed project-level Myco config in the main checkout and need the same identity in a worktree, use the Symbionts page for that worktree too.

### `myco doctor` reports agent configuration drift

Run `myco doctor --fix`, or visit the Symbionts page in the dashboard and trigger re-detect.
