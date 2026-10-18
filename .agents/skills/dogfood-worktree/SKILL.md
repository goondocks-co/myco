---
name: dogfood-worktree
description: Build and smoke-test Myco member or server changes from an isolated git worktree.
---

# Dogfood a worktree

Build with `make source-build` from the checkout. It prepares vendor SQLite, the Deployment UI and generated carriers, then compiles and verifies the host binary. `make build` runs the repository checks and builds; run it before finishing a change.

Run the absolute artifact path from a scratch cwd with every home inside scratch. On macOS/Linux, choose your lane's scratch root and use:

```bash
artifact="$(pwd)/packages/myco-$(node -p 'process.platform + "-" + process.arch')/bin/myco"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/myco-worktree-XXXXXX")"
mkdir -p "$scratch/home" "$scratch/tmp" "$scratch/cwd"
(
  export HOME="$scratch/home" USERPROFILE="$scratch/home"
  export CODEX_HOME="$HOME/.codex" CLAUDE_CONFIG_DIR="$HOME/.claude"
  export XDG_CONFIG_HOME="$HOME/.config" MYCO_HOME="$HOME/.myco"
  export LOCALAPPDATA="$HOME/AppData/Local" TMPDIR="$scratch/tmp"
  cd "$scratch/cwd"
  "$artifact" --version
  "$artifact" doctor
  "$artifact" member status
)
```

Inspect the reported home and installation provenance before attributing state. A directly run artifact has unknown installation origin until it has been installed. This recipe creates no repository pins or personal configuration.

To test installation, retain those scratch variables and cwd for the binary, and invoke `ALLOW_WORKTREE_INSTALL=1 make -C /absolute/worktree source-install`. Installation builds and verifies once, then the candidate's updater copies it into the selected home's managed destination. Worktree installation requires that explicit opt-in. Use `make source-install` for a deliberate personal source install; plain `myco update` returns it to the selected channel release.

A member has no daemon or local vault. Hooks load the installed binary per invocation; a native Deployment and a registered runner keep their executable until their process restarts. Use local Deployments and injected service runners for tests. A per-user service manager ignores `HOME`; scratch homes alone do not isolate service registration. Stop only processes you started and verify none remains before finishing.

For Windows, cross-build on macOS/Linux, copy the `.exe`, and install it using the recorded build-machine checkout and commit. See [Contributing](../../../CONTRIBUTING.md#source-builds-on-windows). Set Windows `USERPROFILE` and `LOCALAPPDATA` inside scratch as well as the other home variables, and run from a scratch cwd.
