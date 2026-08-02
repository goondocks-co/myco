# Myco Collective

> **Status: not currently integrated with the daemon, pending redesign for Team Host.** The Collective was built for the retired Team Sync (Cloudflare) stack, and its daemon-side integration was removed when Team Sync was retired. Nothing on this page is a current install path — it is a design record of how the Collective worked, kept for reference until the Team Host-era redesign lands. The `@goondocks/myco-collective` and `@goondocks/myco-team` packages still exist on npm but are **dormant**: not released alongside Myco, and not managed by the dashboard's Upgrade section.

The Collective was an optional admin layer above Team Sync: one place to search across projects and manage shared settings for the team workers connected to it.

It sat above team sync:

- each project kept its own local Myco install
- each project could sync to a team worker
- one Collective could connect multiple team workers and search across them

## What it provided

- Cross-project search with project attribution on every result
- A single place to see connected projects and their health
- Shared settings overrides that flowed down through each project's team worker
- A worker-hosted admin UI for projects, settings, and search

The Collective never replaced the local Myco install. Developers still ran `myco` in each project; the Collective was for operators who wanted one view across multiple Myco-enabled projects.

## How it worked

Operators installed the Collective CLI (`@goondocks/myco-collective`) on the machine that managed it, alongside a Cloudflare account, an authenticated `wrangler`, and at least one project already using Team Sync. `myco-collective install` provisioned the Collective Worker, its database, and the admin UI in one step; the deployed worker URL served four pages — Dashboard (connected projects and health), Projects (add or remove team workers), Settings (shared overrides), and Search (cross-project search).

Each project had to belong to a team first: `myco-team create` (from the `@goondocks/myco-team` operator CLI) deployed the team's Worker, and `myco-collective add-project <name> <worker_url> <api_key>` connected that Worker to the Collective. The team CLI also carried the operator lifecycle — `update`, `status`, `rotate-tokens`, `reindex-vectors`, and `destroy` for tearing down a team's Cloudflare resources; `myco-collective` had matching `rotate-tokens` and `destroy` commands for the Collective's own credentials (admin UI/API, cloud MCP surface, and project-to-Collective communication) and deployment.

When the integration was live, connecting a project meant:

- the local Team page showed Collective status
- local `collective_*` tools (`collective_search`, `collective_projects`, `collective_project`) became available automatically
- shared settings flowed through Team Sync to the local Myco service

None of this is wired into the current daemon — the `collective_*` tools and the Team page integration were removed with Team Sync's retirement.

## Today

Myco's shipped answer for team knowledge is [Team Host](team-host.md): join a teammate's Myco directly, connect projects to it, and optionally expose read-only access to agents outside the team. The main Myco product keeps itself up to date automatically (or from the **Upgrade** section of the dashboard's **Settings** page); the dormant operator packages are not part of that cycle.

If a cross-team layer returns, it will be redesigned around Team Host rather than reviving the Cloudflare deployment described above.
