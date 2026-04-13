---
name: myco:configure-dev-binary
description: |
  Use this skill when you need to make the Myco project itself use `myco-dev` (the locally-built binary from `dist/index.cjs`) instead of the globally-installed `myco`. This applies whenever you are dogfooding unreleased changes, setting up a new dev machine, or switching back to the production binary. Even if the user only says "test my changes locally" or "run the dev build," invoke this skill — the binary-switching mechanism is non-obvious and has a three-generation history of failed approaches that this skill documents.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Configure Myco Dev Binary for Local Development

When developing Myco itself, you often need the project's hooks and daemon to invoke your locally-built binary rather than the globally-installed `myco`. The mechanism for this is a single file — `.myco/runtime.command` — written by `make dev-link` and read by `myco-hook.cjs` at hook-fire time. This approach was chosen after two earlier designs failed in practice; understanding why helps you avoid reintroducing them.

## Prerequisites

- The project is built: `dist/index.cjs` must exist. Run `make build` first if it doesn't.
- You are in the repository root (`/Users/chris/Repos/myco` or equivalent).
- The globally-installed `myco` is already working (used as the fallback when `.myco/runtime.command` is absent).

## Steps

### 1. Link the dev binary

```bash
make dev-link
```

This does two things:
- Creates `~/.local/bin/myco-dev` as a symlink pointing at `dist/index.cjs` in your repo.
- Writes `.myco/runtime.command` containing the absolute path to `myco-dev`.

`myco-hook.cjs` reads `.myco/runtime.command` at every hook invocation and substitutes that path for the default `myco` command. Because the read happens at hook-fire time (not at shell startup), no shell restart is required.

### 2. Confirm `.myco/runtime.command` is gitignored

The file holds your machine's absolute path, so it must never be committed. Verify it appears in `VAULT_GITIGNORE` in `src/cli/shared.ts`:

```bash
grep 'runtime.command' src/cli/shared.ts
```

You should see it listed. If it's missing, add it — the daemon uses this array to populate `.myco/.gitignore` during `myco init`.

### 3. Build after code changes

After editing source files, rebuild:

```bash
make build
```

Because `~/.local/bin/myco-dev` is a symlink to `dist/index.cjs` in your repo, the rebuilt artifact is immediately available to hooks without re-running `make dev-link`.

### 4. Verify

```bash
myco-dev doctor
```

The output should report the dev binary path. If it falls back to the global binary path, check that `.myco/runtime.command` exists and contains the correct path.

### 5. Revert to the production binary

```bash
make dev-unlink
```

This removes `.myco/runtime.command` and deletes the `~/.local/bin/myco-dev` symlink. Hooks fall back to the globally-installed `myco` automatically because `myco-hook.cjs` treats a missing `.myco/runtime.command` as "use the default."

## Why not the alternatives?

**`MYCO_CMD` environment variable (first design — abandoned)**
Hooks run inside Claude Code's subprocess environment. Codex and other nested subprocess contexts silently strip custom env vars, so `MYCO_CMD` would be set in the terminal but invisible to the hook. This caused unpredictable fallback to the global binary with no error.

**`~/.local/bin/myco-dev` symlink alone (second design — abandoned)**
Shell PATH ordering is fragile. In some contexts the global `myco` resolved first; in others the symlink resolved first. The result was non-deterministic binary selection depending on how the shell was launched.

**`.myco/runtime.command` file (current design)**
The hook reads an explicit file path — there is no PATH lookup and no env var inheritance. The selection is deterministic regardless of shell, subprocess depth, or IDE.

## Gotchas

- **Never delete `bin/myco-run`** even if it looks unused. It is the stable entrypoint for MCP server mode. Deleting it breaks MCP-based integrations.
- **Use `make dev-link`, not `npm link`.** `npm link` rewires global resolution and will interfere with production-install testing in the same shell session.
- **`.myco/runtime.command` is machine-specific.** If you copy your repo to another machine, re-run `make dev-link` there — the path baked into the file will be wrong otherwise.
- **Rebuild before testing.** `myco-dev doctor` (or any hook) reads the binary on disk. Stale `dist/index.cjs` means stale behavior, even if your source edits look right.
