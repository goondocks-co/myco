# Myco

**Your agents learn from the work you have already done.**

Myco captures coding sessions, then its own agent turns that work into durable project knowledge: decisions, discoveries and lessons called **spores**, alongside the plans your agents write. That knowledge returns to your coding agents at session start and with each prompt, so the next session can build on the last.

Use Claude Code today and Codex tomorrow. Bring a teammate into the project. The knowledge stays with the project, across agents and machines.

## How it works

1. **Capture the work.** Myco records sessions and plans from Claude Code, Codex, Cursor, OpenCode, Pi and Cline.
2. **Learn from it.** Myco's agent draws out what is worth keeping, updates earlier knowledge and gives sessions useful titles. It can also learn from a connected repository and build a code map.
3. **Bring it back.** Your agents receive project instructions at session start and relevant spores and plans with each prompt. They can search further and record what they learn through Myco's tools.

Learning runs on a runner your administrator sets up.

## Get started

Install the native binary on macOS or Linux; no Node runtime is needed:

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Windows x64 has an installer, but the 2.0 Windows path is not yet verified:

```powershell
irm https://myco.sh/install.ps1 | iex
```

New to the team? Ask your administrator for the one-time login command from **People & machines › Invite a teammate**, and run it. After you join, ask them to use **Connect GitHub** and send you the link to connect your account for dashboard access.

If you already sign in to the dashboard, you can use your Myco's address instead:

```bash
myco setup --join <address>
```

Approve the machine in a browser signed in to that Myco. Start a new agent session in a repository under `~/Repos`, and see it on **Today**. The [Join a Myco guide](docs/quickstart.md) covers joining, other folders and checking your setup.

- [Run your own Myco](docs/self-hosting.md): `myco setup` guides creation on Cloudflare or this machine.
- [Move from Myco 1.4](docs/upgrade.md#upgrading-from-myco-14): `myco setup` previews the move and keeps your source data.
- [Connect your agents](docs/agents.md) and see what is captured.
- [Agent tools and skills](docs/agent-tools.md) for reading and recording project knowledge.
- [External agents](docs/external-agents.md) for hosted reviewers and the plugin-only path.

The installers select an available 2.x release. Use them for 2.0; the unqualified npm package may still select the 1.4 release line.

## Your project's knowledge

Open the dashboard at your Myco's address. **Today** shows the work arriving, **Sessions** lets you revisit it, and **Knowledge** holds spores, plans and the code map. **Myco’s work** shows what Myco's own agent has done. Administrators manage projects, people, runners and settings there too.

Processed project knowledge is shared across the Deployment. Raw capture is private to its uploader. Keep separate security or client boundaries in separate Deployments.

Install Myco from your agent's plugin marketplace for tools and skills without the binary. Provide your Myco's address and a project access key when asked. The plugin alone does not capture sessions; the `/myco-setup` skill helps add the binary when you want capture. See [External agents](docs/external-agents.md).

## Check and update

```bash
myco doctor
myco setup --status
myco update --check
myco update
```

To leave a Myco, use `myco logout <address>`. Captured data is kept; runner registrations are separate. See [Join a Myco](docs/quickstart.md#leaving-a-myco).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [canonical architecture](docs/architecture/myco-2.0.md) and [Actors & boundaries](docs/architecture/actors-and-boundaries.md).

Licensed under [Apache 2.0](LICENSE). Copyright Goondocks Consulting LLC.
