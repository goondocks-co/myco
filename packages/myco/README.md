# @goondocks/myco

`@goondocks/myco` is the main Myco package: the nervous system for AI-assisted software teams.

Install it once to run the local dashboard and service, connect supported coding agents, capture project knowledge, and use the built-in intelligence pipeline.

Myco is a self-contained native binary — **no Node runtime is required to run it**. The recommended install downloads the binary directly:

```bash
curl -fsSL https://myco.sh/install.sh | sh        # macOS / Linux
irm https://myco.sh/install.ps1 | iex             # Windows x64 (PowerShell)
```

This npm package is a thin bootstrap that converges to the same native binary, for people who prefer installing through npm (this path needs Node 22+):

```bash
npm install -g @goondocks/myco
```

Open a git project in any supported agent and Myco registers it automatically when the agent starts working there.

macOS is the primary supported platform. Linux and Windows are in beta. On Windows, only **x64** is supported — Windows on ARM (which runs the x64 build under emulation) is not supported.

## What you can do

- Capture coding sessions into a local Myco vault
- Run the local dashboard, service, and MCP server
- Search sessions, spores, plans, and artifacts
- Give agents shared project context without replacing their native memory or workflows
- Share project intelligence by joining a Team Host, with no cloud account required
- Connect multiple team workers to a Myco Collective

## Upgrade

Myco keeps itself up to date automatically — the local service self-updates from your release channel in the background while it's idle. You can also trigger an upgrade from the **Upgrade** section of the dashboard's **Settings** page, or run `myco upgrade` (with `--channel stable|beta`) for advanced or scripted use. No `npm update` is required.

## Learn more

- Project homepage: <https://github.com/goondocks-co/myco>
- Quickstart: <https://github.com/goondocks-co/myco/blob/main/docs/quickstart.md>
- Team Host: <https://github.com/goondocks-co/myco/blob/main/docs/team-host.md>
- Collective: <https://github.com/goondocks-co/myco/blob/main/docs/collective.md>

## License

Apache-2.0
