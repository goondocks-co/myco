# Dogfood Home Migration

This runbook is for contributors who run a dev daemon from a local source checkout.
**Production users (those who installed myco via npm or the native installer) have nothing to do — skip this entirely.**

## What changed

The dev daemon now runs against its own home directory (`~/.myco-dev`) instead of sharing `~/.myco` with the production daemon.
This keeps dev groves, config, and state isolated from your production data.

`make dev-link` now:

- Creates `~/.myco-dev/` and writes a `config.yaml` with `update_channel: manual` so the dev daemon never auto-upgrades.
- Writes `.myco/runtime.home` = `~/.myco-dev` so the launcher routes in-repo invocations to the dev home.

`make daemon-dev` now launches with `MYCO_HOME=~/.myco-dev MYCO_CLAIMS_HOME=~/.myco` so the dev daemon:

- Stores groves, sessions, and state under `~/.myco-dev/` (isolated).
- Reads subsystem claims from `~/.myco/` (shared with the production daemon).

## Migration steps

### 1. Stop the dev daemon

Kill any running `make daemon-dev` process (Ctrl-C or `kill $(lsof -ti :19344)`).

### 2. Run dev-link

```sh
make dev-link
```

This builds the binary, symlinks it, creates `~/.myco-dev/config.yaml`, and writes `.myco/runtime.home`.

### 3. Register the myco project under the dev home

```sh
MYCO_HOME=$HOME/.myco-dev myco init
```

This registers this repo as a grove under `~/.myco-dev/groves/` so the dev daemon owns it.
The production daemon continues to own groves under `~/.myco/groves/`.

### 4. Start the dev daemon

```sh
make daemon-dev
```

### 5. Verify isolation

- Confirm capture flows to `~/.myco-dev/groves/` (check `ls ~/.myco-dev/groves/`).
- Confirm `~/.myco/` is untouched by the dev daemon (production groves and state unchanged).

## PRUNE — required for existing contributors

Older dev setups registered the dev daemon under `~/.myco/service-dev` and owned groves from `~/.myco/groves/` with `served_by` set to something other than `'service'`.
These leftovers must be removed; the simplified home-as-filter reads `~/.myco/groves/` for the production daemon and any non-`service` entry would be loaded erroneously.

Run these two cleanup steps **before** starting the new dev daemon:

**Step A — remove the old dev state directory:**

```sh
rm -rf ~/.myco/service-dev
```

**Step B — remove any leftover dev-owned groves from the production home:**

Groves under `~/.myco/groves/` with `served_by` not equal to `'service'` were created by the old dev daemon.
Identify and remove them:

```sh
for dir in ~/.myco/groves/*/; do
  toml="$dir/grove.toml"
  if [ -f "$toml" ]; then
    served_by=$(grep '^served_by' "$toml" | grep -oP "(?<=served_by = ')[^']+")
    if [ -n "$served_by" ] && [ "$served_by" != "service" ]; then
      echo "Removing dev-owned grove: $dir (served_by=$served_by)"
      rm -rf "$dir"
    fi
  fi
done
```

After pruning, only groves with `served_by = 'service'` remain in `~/.myco/groves/` — the production daemon loads exactly those.

## Live smoke verification (manual gate before merging)

After completing the steps above:

1. Run `make dev-link && make daemon-dev`.
2. In another terminal, run `myco upgrade status` (from within the repo) — confirm it shows `manual` channel and no pending auto-stage.
3. Confirm in-repo `myco` commands hit the dev home: sessions and groves should appear under `~/.myco-dev/`.
4. Confirm the production daemon (if running) auto-adopts a newer beta cleanly: caps survive, no doubled path.
