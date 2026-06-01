# Upgrading Myco

Myco upgrades are a single command. The npm package carries the CLI, local service, dashboard, agent connections, and built-in intelligence features. Update the package, then restart Myco when you want the new version to take over.

## TL;DR

```bash
npm install -g @goondocks/myco@latest
```

That's it. The next time Myco restarts, it updates your local service, preserves your existing agent settings, and brings registered projects forward. No per-project command is required.

To force the new version to take effect immediately:

```bash
myco restart
```

## What the package upgrade does

After `npm install -g @goondocks/myco@latest` and the next Myco restart:

1. **Updates Myco's local service and dashboard** to the new version.
2. **Refreshes supported agent connections** while preserving settings you already had in those agents.
3. **Archives Myco-owned files from older per-project installs** instead of deleting them.
4. **Keeps registered Groves and projects intact** and reports anything that needs attention through the dashboard and `myco doctor`.

Project registration continues automatically as you use supported agents from git projects.

## v1.0: agent and embedding settings now live in the Grove

Myco v1.0 makes agent and embedding configuration **Grove-scoped** — one setting shared by every project in a Grove, instead of a separate copy in each project's `myco.yaml`.

**Breaking change.** On the first restart after upgrading to v1.0, Myco removes agent and embedding settings from every project's `myco.yaml` and resets those projects to the Grove's configuration. The fields reset are the agent provider, harness, model, per-task overrides, the scheduling toggles, and the embedding provider, model, and base URL.

Most projects carried these values only because older Myco wrote them per-project, so the Grove already holds the same configuration and the reset changes nothing you can observe. If a project ran a genuinely different agent or embedding setup, reconfigure it at the **Grove** scope from the dashboard's Settings and Operations pages after the upgrade.

Need a per-project value for a specific field? Use the scope pill on that field in the dashboard to opt it back to project scope. Layering is opt-in per field — nothing is project-scoped by default.

The previous values are not lost: the pre-upgrade `myco.yaml` is in your git history, and Myco archives older Myco-owned files rather than deleting them.

## From v0.25.x or earlier (per-project install era)

If you previously had per-project `.agents/` installs:

1. `npm install -g @goondocks/myco@latest`.
2. Let Myco restart (or run `myco restart`).
3. Myco archives older Myco-owned per-project files in place.
4. Per-project overrides now live in the dashboard's **Symbionts** page. You can disable a symbiont in a specific project from there.

After the upgrade, verify with `myco doctor`. It reports anything Myco could not update automatically.

## From per-machine MIT-era installs

The license changed from MIT to Apache 2.0 on 2026-04-29 (commit `57a9571a`). No code action required, but if your team's compliance review tracks license metadata, re-acknowledge.

## Optional operator packages

If you also installed one of the standalone operator CLIs, they upgrade independently. The Operations page in the dashboard detects updates for them too and offers a one-click apply.

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

Myco archives older Myco-owned per-project files rather than deleting them. To return to a previous version, reinstall that version and restart:

```bash
npm install -g @goondocks/myco@<previous-version>
myco restart
```

If you want to remove Myco entirely:

```bash
myco remove           # remove Myco's contributions from every agent's global config
myco remove --purge   # additionally remove ~/.myco/ itself
```

Removal preserves user-pre-existing keys in shared agent config files.

## Common failure modes

### Myco didn't pick up the new code

Myco does not auto-restart on `npm install`. Run `myco restart` explicitly.

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
