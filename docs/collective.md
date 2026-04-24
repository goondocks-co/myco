# Myco Collective

Run one Myco Collective to search across projects and manage shared settings for the team workers connected to it.

The Collective sits above team sync:

- each project keeps its own local Myco install
- each project can sync to a team worker
- one Collective can connect multiple team workers and search across them

## What you get

- Cross-project search with project attribution on every result
- A single place to see connected projects and their health
- Shared settings overrides that flow down through each project's team worker
- A worker-hosted admin UI for projects, settings, and search

The Collective does not replace the local Myco install. Developers still run `myco` in each project. The Collective is an optional admin layer for operators who want one view across multiple Myco-enabled projects.

## Install

Install the Collective CLI on the machine that will manage it:

```bash
npm install -g @goondocks/myco-collective
```

You also need:

- a Cloudflare account
- `wrangler` installed and authenticated
- at least one project already using [team sync](team-sync.md)

## Create a Collective

```bash
myco-collective install
```

That command provisions the Collective Worker, its database, and the admin UI in one step.

After install, open the deployed worker URL in your browser. The admin UI gives you four pages:

- **Dashboard** — connected projects and health
- **Projects** — add or remove team workers
- **Settings** — shared overrides
- **Search** — cross-project search from one place

## Connect a project

Each project needs team sync first.

From the project itself (after installing `@goondocks/myco-team`):

```bash
myco-team install
```

Then add that team worker to the Collective:

```bash
myco-collective add-project <name> <worker_url> <api_key>
```

Once connected:

- the local Team page shows Collective status
- local `collective_*` tools become available automatically
- shared settings flow through the team worker to the local daemon

## Upgrade path

### Existing Myco users

If you already use Myco locally, your normal upgrade path does not change:

```bash
npm update -g @goondocks/myco
```

That updates the main Myco CLI, daemon, hooks, and dashboard. Users who are only *connecting* to an existing team don't need anything else.

### Team operators

Anyone provisioning or administering a team worker needs the team operator CLI:

```bash
npm install -g @goondocks/myco-team
```

That adds:

- `myco-team install` — provision team sync (D1 + Vectorize + KV + Worker)
- `myco-team upgrade` — redeploy the worker
- `myco-team status` — show worker info and credentials
- `myco-team rotate-tokens` — rotate API key and/or MCP token
- `myco-team reindex-vectors` — rebuild the Vectorize index
- `myco-team destroy` — tear down all Cloudflare resources

### Collective operators

Install `@goondocks/myco-collective` only if you want to run a Collective.

It is separate because it manages a different Cloudflare deployment and admin surface from the per-project Myco install.

## Update

Update the Collective CLI directly:

```bash
npm update -g @goondocks/myco-collective
myco-collective upgrade
```

If you also use the standalone team CLI, you can still update it directly:

```bash
npm update -g @goondocks/myco-team
myco-team upgrade
```

Project-local Myco installs still update through `@goondocks/myco`. Once the standalone Team or Collective CLI is installed on a machine, the main Myco Operations page also detects and applies those package updates for you.

## Daily use

Most day-to-day work stays in the normal Myco surfaces:

- developers use `myco` locally
- the local Team page shows whether the project is connected to a Collective
- local agents use `collective_search`, `collective_projects`, and `collective_project` when a Collective is connected

The Collective UI is for operators who need to add projects, change shared settings, or run cross-project searches directly.

## Authentication

The Collective uses separate credentials for:

- the admin UI and admin API
- the cloud MCP surface
- project-to-Collective worker communication

Rotate them with:

```bash
myco-collective rotate-tokens admin
myco-collective rotate-tokens mcp
myco-collective rotate-tokens all
```

## Remove

```bash
myco-collective destroy
```

If remote cleanup fails, the CLI keeps the local config so you can retry safely.
