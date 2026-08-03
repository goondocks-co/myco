# @goondocks/myco-collective

> **Status: dormant.** This package is retained in the repository but is not
> currently integrated with the myco daemon, pending redesign.

`@goondocks/myco-collective` deploys and manages a Myco Collective.

Install it when you want the cross-project admin layer:

```bash
npm install -g @goondocks/myco-collective
```

Most Myco users do not need this package. It is for operators who want to connect multiple Team Sync deployments to one Collective and manage them from a shared admin UI.

Collective admin state is stored per deployment under `~/.myco-collective/<name>/`.

## What you can do

- Install or upgrade a Collective deployment
- Open the worker-hosted admin UI
- Add and remove connected projects
- Rotate admin and MCP tokens
- Destroy a Collective deployment

## Common commands

```bash
myco-collective install oss
myco-collective status oss
myco-collective add-project myco-main https://team.example.workers.dev <api_key> oss
myco-collective rotate-tokens admin oss
myco-collective destroy oss
```

## Upgrade

This package no longer receives new releases. If you have an existing install, you can still re-run:

```bash
npm update -g @goondocks/myco-collective
```

## Learn more

- Main project: <https://github.com/goondocks-co/myco>

## License

Apache-2.0
