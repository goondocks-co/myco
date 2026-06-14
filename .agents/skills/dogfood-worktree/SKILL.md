---
name: dogfood-worktree
description: Procedure for dogfooding Myco changes inside a git worktree so capture, MCP, and CLI route to the worktree's own build instead of the production binary. Use when developing Myco in a git worktree, when capture/MCP in a worktree behaves like production or points at the wrong build, or when wiring up `make dev-link-worktree` / `make dev-unlink-worktree`. Covers why `.myco/runtime.command` does not travel with `git worktree add`, why a build must happen first, the shared-vault schema rollup hazard across worktrees, and the vendor-asset build gotcha.
---

# Dogfooding Myco in a Git Worktree

This is a **dogfood-only** concern — myco using myco to build myco. A regular
user just has one `myco` installed; their own worktrees "just work" because
everything resolves to that single binary. The complexity here exists only
because we run a **dev** binary (`myco-dev`) alongside the **prod** binary
(`myco`) and need capture to keep working while we change Myco itself.

## The core gotcha: a fresh worktree is not myco-dev aware

Binary resolution (global launcher `~/.myco/launcher.cjs` and `bin/myco-run`)
walks **up from the working directory** looking for `<dir>/.myco/runtime.command`,
then the machine pin, then the vendored binary, then PATH `myco`.

`.myco/runtime.command` is **gitignored** (`.myco/.gitignore`). `git worktree add`
only materializes *tracked* files, so a new worktree starts with **no pin**.
With no pin:

- A worktree **nested** under the main checkout (e.g. `.worktrees/foo`) walks up
  and finds the *main checkout's* pin → runs **main's `myco-dev`** (stale vs. the
  worktree's changes).
- A **sibling** worktree (e.g. `../myco-foo`) finds nothing → hooks fall through
  to PATH `myco` = the **production** binary. Capture then hits the prod
  daemon/vault. Unacceptable for dogfooding.

Either way a fresh worktree never uses **its own** build until you pin it.

## Procedure

1. **Create the worktree** off the branch you're developing:
   ```bash
   git worktree add ../myco-<feature> <branch>
   cd ../myco-<feature>
   ```

2. **Pin it to its own build:**
   ```bash
   make dev-link-worktree
   ```
   This depends on `dev-build`, so it **builds the worktree's binary first**,
   then writes `<worktree>/.myco/runtime.command` → `packages/myco-<target>/bin/myco`.
   It does **not** touch the shared `~/.local/bin/myco-dev` symlink (the main
   checkout and other agents rely on it), and it does **not** write project-local
   launchers (`.agents/myco-run.cjs` is retired — the global launcher + cwd-walk
   handle routing through the pin).

3. **Verify routing:** from inside the worktree, hooks, MCP, and CLI now dispatch
   to the worktree binary. Capture still attaches to the **main project vault**
   (resolved via `git rev-parse --git-common-dir`) — worktrees are not a separate
   Myco project by design; their data rolls up to the main tree.

4. **Revert when done:**
   ```bash
   make dev-unlink-worktree   # removes the worktree's .myco/runtime.command
   ```
   Resolution then falls back through the chain (→ prod `myco` for a sibling
   worktree), so unlink only when you're finished dogfooding that worktree.

## Caveats — codified so we stop rediscovering them

### Shared-vault schema rollup (the big one)
Every worktree **and** the main checkout resolve to the **same** Grove vault
(`myco.db`) via `git-common-dir`. Each worktree pins to its **own** binary. So a
worktree whose binary runs a **schema migration** mutates the *shared* DB — and
the main checkout or another worktree on an **older** build can then break
(missing/renamed columns, `user_version` mismatch). This is the accepted cost of
the rollup-to-main-vault design; a per-worktree vault was rejected because it
fragments dogfood data and contradicts "worktrees attach to the main project."

- Run **one schema-changing worktree at a time**; rebuild the others to match.
- For genuinely risky schema work, snapshot first with the **`dogfood-grove-claim`**
  skill so you can roll back.

### A build must succeed first
The pin points at `packages/myco-<target>/bin/myco` *inside* the worktree, so that
binary has to exist — `make dev-link-worktree` builds it. **Worktree builds can
fail** when local, gitignored vendor assets (e.g.
`packages/myco/vendor-src/libsqlite3/<target>/libsqlite3.dylib`) exist in the main
checkout but didn't travel to the worktree. If `dev-build` fails on a missing
vendor asset, copy/symlink it from the main checkout (or rebuild it in the
worktree) and re-run `make dev-link-worktree`.

### Daemon-side changes: dogfood from the MAIN checkout, never the worktree
The worktree pin only routes **hooks, MCP, and CLI** to the worktree binary. The
dev **daemon** always runs the **main dev binary** — its launchd service points at
the main checkout's `packages/myco-<target>/bin/myco`, so a worktree pin does NOT
change which code the daemon runs.

To dogfood **daemon-side** changes (schema migrations, reconcile/daemon logic):
check out the feature branch on the **main checkout** and rebuild + restart there —
`make dev-build && myco-dev restart`. After a worktree teardown + rebase the
`~/.local/bin/myco-dev` symlink already points at the main binary, so **no
`make dev-link` is needed** — only re-link if the symlink was removed or you are
switching which branch the daemon tracks. After any restart, verify
`~/.myco/service-dev/daemon.json` is not still pointing at a stale worktree binary.

**Never** `make dev-link` from a worktree, and **never** run the daemon or migrate
the shared vault from a worktree — a worktree binary running a migration mutates the
*shared* Grove vault and breaks the main/other builds (the rollup hazard above). The
only isolated paths are `dogfood-grove-claim` (snapshot a Grove) or exercising the
merged code against a **temp git repo with its own `MYCO_HOME`** — neither touches
the shared vault.

> Myco is the most active source of truth: search the vault ("worktree dogfood")
> before trusting this skill if they disagree. See also the
> `daemon-process-lifecycle-management` skill for the canonical build/restart commands.

## Related
- `dogfood-grove-claim` — snapshot/rollback a Grove for risky (e.g. schema) testing
- `make dev-link` / `make dev-unlink` — the main-checkout dev pin (rewrites the
  shared `~/.local/bin/myco-dev` symlink); never run these from a worktree
