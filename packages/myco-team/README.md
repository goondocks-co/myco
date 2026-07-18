# @goondocks/myco-team

> **Status: dormant.** This package is retained in the repository but is no
> longer published or maintained. Team functionality now lives in Team Host,
> built into the `myco` binary (`myco host …`, `myco join`, `myco attach`).
> The Cloudflare Worker + D1 stack this package deploys is retired.

`@goondocks/myco-team` manages a Myco Team Sync deployment from the terminal.
A team is a global, machine-scoped entity: `create` provisions a new team's
Cloudflare worker from anywhere — no project or Grove context required — and you
assign which projects sync to it from the dashboard **Teams** tab afterwards.

Install it to provision or administer a team worker:

```bash
npm install -g @goondocks/myco-team
```

Team operators need this package; teammates who only *connect* to an existing team worker through the Myco dashboard do not.

## What you can do

- Create, upgrade, or destroy a Team Sync worker
- Check deployment status
- Rotate API and MCP tokens
- Back up a team's config and restore or recover it on another machine

## Common commands

```bash
myco-team create --name "Acme Core"          # provision + deploy a new team worker
myco-team create --name "Acme Core" --domain example.com   # bind to a custom Workers zone
myco-team status --team-id <team_id>
myco-team update --team-id <team_id>         # redeploy the worker
myco-team rotate-tokens api --team-id <team_id>
myco-team rotate-tokens mcp --team-id <team_id>
myco-team destroy --team-id <team_id>
myco-team export --team-id <team_id> --out ./backup   # portable backup bundle
myco-team import ./backup/<bundle>.myco-team.json     # restore from a bundle
myco-team adopt --worker-url <url> [--api-key <key>]  # rebuild local state from a live worker
```

Every command except `create`, `import`, and `adopt` addresses a team by
`--team-id` (list registered teams from the dashboard **Teams** tab).

## Upgrade

This package no longer receives new releases. If you have an existing install, you can still re-run:

```bash
npm update -g @goondocks/myco-team
```

## Learn more

- Main project: <https://github.com/goondocks-co/myco>
- Team Host guide: <https://github.com/goondocks-co/myco/blob/main/docs/team-host.md>

## License

Apache-2.0
