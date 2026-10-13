---
name: dogfood-worktree
description: Build and smoke-test Myco member or server changes from an isolated git worktree.
---

# Dogfood a worktree

`make dev-build` builds vendor SQLite, the Deployment UI, generated bundles and the host binary. `make build` runs checks and builds without restarting a service.

For a project-local runtime override, `make dev-link-worktree` writes `.myco/runtime.command`, `.myco/runtime.home` and a wrapper pointing at that worktree's binary. It leaves shared command links alone. `make dev-unlink-worktree` removes those pins.

Set `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `MYCO_HOME` and `TMPDIR` inside your scratch directory for tests. Run any Myco command from that scratch directory. An explicit `MYCO_HOME` wins over the wrapper's default dev home; verify `myco doctor` and `myco member status` before attributing capture to a Deployment.

A member has no daemon or local vault. Hooks load the binary per invocation; a native Deployment and a registered runner each keep their running executable until their own process restarts. Restart only an isolated process you started. Agent work runs on registered runners.

Use injected service runners for lifecycle tests. A per-user service manager ignores `HOME`, so sandbox homes alone do not isolate service registration.
