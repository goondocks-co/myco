# One-shot recovery: co-tenant orphan cleanup (2026-05-25)

**These are POINT-IN-TIME RESCUE SCRIPTS, not reusable tooling.**

They were used once to repair the developer's machine after the
co-tenant-hook orphan accumulation bug (PR #355). They hardcode:

- A specific session id (`90f7ca3f-9835-47b6-803a-1ec82316dc13`)
- A specific Grove id (`grove_b7e9d7eb502816dafb8ae9eebe5bfa25`)
- The developer's home (`/Users/chris/...`)

Each script has a machine guard at the top that exits non-zero on any
other machine. Do not run on a different host. Do not modify the paths
to "make them generic" — the right tool for ongoing recovery is the
canonical-launcher ownership detector + sandbox sentinel + global-config
scrub path in `myco update` / `myco doctor --fix`, which together close
the bug class structurally.

Kept in-tree as evidence of the recovery, not as a runtime utility.

The structural fixes that close the bug class:

- Canonical launcher-path ownership detection in
  `packages/myco/src/symbionts/install-helpers.ts` — steady-state
  reinstall/update removes only canonical Myco-owned hook entries and
  preserves co-tenant hooks.
- `MYCO_SANDBOX_ROOT` sentinel in `expandHome`
  (`packages/myco/src/grove/paths.ts`) — refuses to expand `~` when a
  sandbox is declared but `HOME` falls outside it.
- Targeted escaped-smoke scrub in
  `packages/myco/src/grove/global-config-migration.ts`, wired into
  `myco update` and `myco doctor --fix`, for old `/tmp/myco-*-smoke`
  launcher entries already written into real global agent config.
- Safe smoke bootstrap helper `scripts/dev/smoke-sandbox-env.sh` so
  future manual smoke runs export `MYCO_SANDBOX_ROOT`, `HOME`,
  `MYCO_HOME`, and `MYCO_LAUNCH_AGENTS_DIR` together.
