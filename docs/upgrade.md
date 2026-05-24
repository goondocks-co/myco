# Upgrading Myco

Myco upgrades are a single command. The npm package carries the CLI, daemon, hooks, dashboard, and all symbiont templates — bump the package and the running daemon picks up the new code on its next restart.

## TL;DR

```bash
npm install -g @goondocks/myco@latest
```

That's it. The next time the daemon restarts (manually or automatically), it runs the migration walker, reconciles every registered project, and refreshes each symbiont's global config to match the new templates. No per-project command is required.

To force the new version to take effect immediately:

```bash
myco restart
```

## What the package upgrade does

After `npm install -g @goondocks/myco@latest` and the next daemon start:

1. **Migration walker** runs across every Grove the daemon knows about. Stale project-local artifacts from earlier per-project installs (`.agents/myco-buffer/`, project-local `.agents/myco-run.cjs`, project-local `.mcp.json` entries written by Myco) are archived in place under each project's `.myco/.archive-<timestamp>/`. Originals are never deleted; the archive is auditable and restorable.
2. **Global launcher rewrite.** `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs` are rewritten to match the new package, including a one-line sentinel so future installs can detect tampering.
3. **Symbiont reconciliation.** Every detected symbiont's global config is re-merged: Myco's hook/MCP/skills entries are upserted; user-pre-existing keys (such as Codex `[features].hooks` you added yourself) are preserved. Writes are atomic across every agent.
4. **Service registration check.** If the per-user service unit is missing or pointing at the wrong binary, it's re-registered. `MYCO_LAUNCH_AGENTS_DIR` is honored for sandbox installs.
5. **Migration audit log.** Each step writes to a bounded audit log. On completion you get a dashboard notification with a summary.

You don't need to run `myco update` per project. There is no `myco init` step.

## From v0.25.x or earlier (per-project install era)

If you previously had per-project `.agents/` installs:

1. `npm install -g @goondocks/myco@latest`.
2. Let the daemon restart (or run `myco restart`).
3. The migration walker archives `.agents/myco-buffer/` and any project-local stubs it owned in each project.
4. Per-project overrides that used to live in CLI flags or `.agents/` files move to the dashboard's **Symbionts** page. You can disable a symbiont in a specific project from there.

After the walker runs, verify with `myco doctor` — it surfaces the migration audit log and flags any residue it couldn't reconcile.

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

After the daemon restarts:

```bash
myco doctor
```

Doctor checks vault config, database, providers, symbiont registration, service registration, and the migration audit log. Use `--fix` to auto-repair fixable issues.

The dashboard's **Symbionts** page shows the live install state for every detected agent and offers a re-detect trigger if anything looks off.

## Variant-aware daemons

Dev builds and production builds of Myco can coexist on the same machine. A daemon launched with `MYCO_SERVICE_VARIANT=service-dev` will only bind to Groves whose `grove.toml` has `served_by = "service-dev"`; a production daemon (`MYCO_SERVICE_VARIANT=service`) only binds to `served_by = "service"`. There is no fall-through.

This means upgrading the prod package never disrupts a contributor's dogfood daemon, and vice versa. See [docs/lifecycle.md](lifecycle.md#variant-aware-daemons) for details.

## Rollback

The migration walker archives prior artifacts under each project's `.myco/.archive-<timestamp>/` rather than deleting them. To revert one project to a pre-global state, restore the relevant files from the archive and reinstall the previous package version:

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

### Daemon didn't pick up the new code

The daemon does not auto-restart on `npm install`. Run `myco restart` explicitly.

### Dashboard shows "Connecting to daemon..."

Hard-reload the tab (Cmd+Shift+R / Ctrl+Shift+R). Older cached HTML may not carry the auth-token bootstrap. If it persists, check the daemon port:

```bash
cat ~/.myco/service/daemon.json | jq .port
```

### A symbiont's hooks aren't firing in a new worktree

Worktrees inherit no `.claude/settings.json` or project-local launcher. The global install model expects hooks to live in each agent's user-global config, where they apply to every worktree automatically. If you've created project-local overrides, re-run `myco init --project <path>` in the worktree.

### `myco doctor` flags hybrid-TOML or missing matchers

Doctor detected drift between the installed template and the on-disk config. Re-run `myco doctor --fix`, or visit the Symbionts page in the dashboard and trigger a re-detect.
