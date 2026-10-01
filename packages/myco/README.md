# @goondocks/myco

`@goondocks/myco` is the main Myco package: the nervous system for AI-assisted software teams. Myco captures what your coding agents do, turns it into durable project knowledge, and hands that knowledge back to every agent on the team.

Myco is a self-contained native binary, so **no Node runtime is required to run it**. The recommended install downloads the binary directly, on macOS or Linux:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh
myco login <invite link>
myco member join
```

`myco login` signs the machine in to your team's Deployment and sets up your coding agents. `myco member join`, run in a repository, connects it to a project there.

This npm package is a thin bootstrap that converges to the same native binary, for people who prefer installing through npm (this path needs Node 22+).

## What you can do

- Capture your coding agents' sessions to your team's Deployment, which you run on Cloudflare or on your own machine.
- Give every agent on the team the project's spores, session-start instructions and code map, without replacing its own memory or workflow.
- See what your agents did, and what Myco learned from it, on your Deployment's dashboard.
- Run a Deployment yourself with `myco server`.
- Move a Myco 1.4 machine to 2.0 with `myco cutover`.

## Learn more

- Project homepage: <https://github.com/goondocks-co/myco>
- Quickstart: <https://github.com/goondocks-co/myco/blob/main/docs/quickstart.md>
- Self-hosting: <https://github.com/goondocks-co/myco/blob/main/docs/self-hosting.md>
- Upgrading from 1.4: <https://github.com/goondocks-co/myco/blob/main/docs/upgrade-from-v1.md>

## License

Apache-2.0
