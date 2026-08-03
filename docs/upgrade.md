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

## Teams

Hosting a team and joining one are part of the main binary — the dashboard's Team page and the `myco host`, `myco join`, and `myco attach` commands alike — and they upgrade automatically with the rest of Myco. There's no separate package for them.

When you update Myco across a team, **update the host first, then the members**, and finish any in-flight project move before updating either machine — see [Team Host](team-host.md) for the details.

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

Myco archives older Myco-owned per-project files rather than deleting them. The self-updater also keeps the previously installed binary, so if an update misbehaves Myco falls back to the prior version automatically — except across a storage-format change, below.

**Rollback is refused across a storage-format change.** Some upgrades update the on-disk format of your data. An older Myco cannot read the newer format, so once an upgrade has updated your data, going back to the older version — automatically after a failed update, or explicitly via `myco upgrade <older-version>` or the Stable/Beta toggle — is refused rather than leaving you with a service that cannot start. The refusal message, `myco doctor`, and the dashboard all say exactly which versions are involved.

**Before any storage-format update, Myco takes a backup automatically.** The backup lands in the affected Grove's regular backup folder, records the pre-upgrade format version inside the file, and is pinned so retention cleanup never reclaims it. If the backup cannot be taken, the format update itself is refused — your data is never migrated without the safety net.

To actually go back across a storage-format change, use the pre-upgrade backup with a fresh data directory:

1. Stop the service (`myco service stop`) and move the affected Grove's data file aside (keep it — it is your newest data): `~/.myco/groves/<grove-id>/myco.db`.
2. Install the older Myco and start it once — it creates a fresh, empty data file in the old format.
3. Restore the pre-upgrade backup into it from the dashboard's backup page (or `myco __restore-backup <db> <backup> <out>` for scripted recovery).

Restoring a backup **merges rows into** the target — it never converts a newer-format file in place, which is why the fresh data directory in step 2 is required. Restore checks the direction: a backup written at a newer storage format than the target database is refused with a message naming both versions, instead of failing partway through.

To pin a specific release line, use the **Stable** / **Beta** channel toggle in the Settings page's Upgrade section — see [Lifecycle](lifecycle.md) for how channels work.

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

### The service won't start after going back to an older version

If the local service stays down after a downgrade and `myco doctor` reports the data is at a newer storage format than the binary supports: the data was written by a newer Myco, and the older binary refuses to touch it rather than risk it. Nothing has been modified. Upgrade Myco back (`myco upgrade`), or follow the recovery steps under [Rollback](#rollback) to go back with a pre-upgrade backup.

### Downgrade leftovers when external access was on

If a machine had **external agent access** enabled (Team page) and is moved to an older Myco that predates the feature, external access quietly turns off, and the public address entry it registered with the overlay network can be left behind. It is inert but visible in `tailscale funnel status`; re-upgrading Myco cleans it up, or remove it manually with `tailscale funnel --https=443 off`. A machine that was mid-enable when the newer version stopped will refuse to start the older binary and say why — finish or disable external access on the newer version first.
