# @goondocks/myco-team

`@goondocks/myco-team` manages a Myco Team Sync deployment from the terminal.
Installs require a Grove-bound Myco project, and the deployment is attached to
the current Grove rather than one project-local vault. New installs name
Cloudflare resources from the Grove slug, for example
`myco-team-myco-dogfood-1a2b3c4d`, so the worker, D1 database, Vectorize index,
KV namespace, and queues are recognizable in Cloudflare.

Install it to provision or administer a team worker:

```bash
npm install -g @goondocks/myco-team
```

Team operators need this package; teammates who only *connect* to an existing team worker through the daemon UI do not.

## What you can do

- Install or upgrade a Team Sync worker
- Check deployment status
- Rotate API and MCP tokens
- Destroy a Team Sync deployment

## Common commands

```bash
myco-team install /path/to/grove-bound-project
myco-team status
myco-team rotate-tokens api
myco-team rotate-tokens mcp
myco-team destroy
```

## Upgrade

After the first install, Myco's Operations page can detect and apply updates for this package automatically on the same machine.

You can also update it directly:

```bash
npm update -g @goondocks/myco-team
```

## Learn more

- Main project: <https://github.com/goondocks-co/myco>
- Team Sync guide: <https://github.com/goondocks-co/myco/blob/main/docs/team-sync.md>

## License

MIT
