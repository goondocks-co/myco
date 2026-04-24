# @goondocks/myco-team

`@goondocks/myco-team` manages a Myco Team Sync deployment from the terminal.

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
myco-team install /path/to/project/.myco
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
