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
installer's `_meta.owner` ownership scheme + sandbox sentinel, which
together prevent the bug class structurally.

Kept in-tree as evidence of the recovery, not as a runtime utility.

The structural fixes that close the bug class:

- `_meta.owner` marker stamped onto every Myco-written hook group
  (`packages/myco/src/symbionts/install-helpers.ts`,
  `packages/myco/src/symbionts/installer.ts`).
- `MYCO_SANDBOX_ROOT` sentinel in `expandHome`
  (`packages/myco/src/grove/paths.ts`) — refuses to expand `~` when a
  sandbox is declared but `HOME` falls outside it.
