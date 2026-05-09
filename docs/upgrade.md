# Upgrading Myco

This guide covers the upgrade procedure from any earlier release to the current one. Most upgrades are a two-command sequence; the Grove migration that landed in 0.25.x is a one-time per-project step folded into `myco update`.

## TL;DR

```bash
# 1. Update the npm package on the machine
npm i -g @goondocks/myco@latest

# 2. From inside each project that uses Myco, run:
cd <your-project>
myco update
# This auto-migrates the project into the machine's default Grove on first run,
# then refreshes managed config (hooks, MCP entries, settings, skills).
# Output ends with: Dashboard: http://localhost:<port>/g/<grove>/p/<project>
```

After every project on the machine is grove-bound, subsequent releases only need:

```bash
npm i -g @goondocks/myco@latest
myco update --all-projects
```

## What `myco update` does

The command is the single entry point that reconciles a project against the installed package version. In order:

1. **Verify vault**: ensure `<project>/.myco/myco.yaml` exists. Fails fast on a non-Myco directory.
2. **Auto-migrate (one-time)**: if the project has a populated `.myco/myco.db` but no Grove binding (`project.toml` absent, or no `grove.binding_id`), run `myco grove migrate-project` against the machine's default Grove. Imports the legacy SQLite + vector data into the Grove's database and archives `.myco/myco.db`, `.myco/vectors.db`, and friends to `.myco/.archive-<timestamp>/`. Skipped on freshly-initialized vaults that have no database yet.
3. **Refresh `.gitignore`**: rewrite to the current template if it drifted.
4. **Re-register symbionts**: regenerate hooks, MCP entries, settings, and skills for every configured agent (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi, VS Code Copilot, Windsurf).
5. **Write version stamp**: record the current version in `.myco/last-update-version`.
6. **Ensure daemon is healthy**: start or restart the global service if it's not reachable.
7. **Print the dashboard URL**: `http://localhost:<port>/g/<grove-slug>/p/<project-slug>` — open it directly to verify the upgrade.

The auto-migration is idempotent. Re-running `myco update` against an already-migrated project skips step 2 — the binding check is the only signal needed.

## `--all-projects`

Use this once every project on the machine is grove-bound:

```bash
myco update --all-projects
```

This iterates every (Grove, project) pair the machine knows about and runs the per-project flow on each. Per-project failures don't abort the loop; the rollup at the end lists what failed.

`--all-projects` does **not** discover unmigrated projects — it only walks the Grove registry. For the very first 0.24.x → 0.25.x upgrade, you still need to run `myco update` once from inside each project root so the auto-migration step fires.

## Order of operations: package then project

Always update the npm package **before** running `myco update`. Otherwise, the running daemon may keep operating on stale code paths even after `myco update` regenerates symbiont configs.

| Step | What you do | What changes |
|------|-------------|--------------|
| 1 | `npm i -g @goondocks/myco@latest` | Fresh binary on disk. Running daemon is **not** automatically restarted. |
| 2 | `myco update` (per project) | Migrates if legacy. Regenerates managed config. Reaches out to the running daemon to ensure it's live, restarting if its API surface drifted. |

Known gap: a stale running daemon can survive across `npm i -g`. If you see odd behavior after upgrading, restart explicitly:

```bash
myco restart
```

## Verifying the upgrade

After `myco update` completes, the bottom of the output looks like:

```
Updated 8 items.
Daemon is running for HTTP MCP.
Dashboard: http://localhost:20915/g/default/p/<project-slug>
Run `myco doctor` to verify setup health.
```

Open the printed URL. The Dashboard center pane should populate within a second.

If the center pane stays on "Connecting to daemon...":

- Hard-reload the browser tab (Cmd+Shift+R / Ctrl+Shift+R) — older HTML may be cached without the auth-token bootstrap that 0.25.1+ injects.
- Confirm the URL port matches `daemon.json`: `cat ~/.myco/service/daemon.json | jq .port`.
- `myco doctor` for a full health sweep.

## Rollback

The auto-migration archives all legacy data to `.myco/.archive-<timestamp>/` rather than deleting it. If you need to revert a project:

```bash
cd <your-project>
# 1. Stop the daemon to release the Grove DB lock
myco restart --stop  # or: kill the daemon PID from ~/.myco/service/daemon.json
# 2. Remove the new bindings
rm -rf .myco/project.toml .myco/migration/
# 3. Restore the legacy data
mv .myco/.archive-<timestamp>/myco.db    .myco/myco.db
mv .myco/.archive-<timestamp>/vectors.db .myco/vectors.db
# 4. Reinstall the previous package version
npm i -g @goondocks/myco@<previous-version>
```

The legacy archive is never auto-deleted — it stays in place so this rollback is always available.

## Common failure modes

### "No myco.yaml found in <vault>. Run 'myco init' first."

`myco update` was invoked outside any Myco project. Either `cd` into a project that has `.myco/myco.yaml`, pass `--project <path>`, or use `--all-projects` to operate on the registry.

### "Project already registered in Grove X; refusing migration into Grove Y"

The project is already bound to a Grove different from the default. Either:

- Pass `--grove <name|id>` to `myco grove migrate-project` to target the existing Grove explicitly, or
- Change the machine default with `myco grove use <name|id>`, then re-run `myco update`.

### Dashboard shows "Connecting to daemon..." after upgrade

Hard-reload the tab. The auth-token bootstrap injected by 0.25.1+ is in the HTML; an older cached page won't have it.
