<p align="center">
  <img src="docs/assets/myco-hero-wide.jpg" alt="Myco" width="100%">
</p>

<p align="center">
  <strong>The nervous system for AI-assisted software teams</strong>
</p>

<p align="center">
  <a href="https://github.com/goondocks-co/myco/actions/workflows/ci.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/goondocks-co/myco/actions/workflows/publish.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/publish.yml/badge.svg" alt="Release"></a>
  <a href="https://github.com/goondocks-co/myco/blob/main/LICENSE"><img src="https://img.shields.io/github/license/goondocks-co/myco?color=22c55e" alt="License"></a>
  <a href="https://github.com/sponsors/goondocks-co"><img src="https://img.shields.io/badge/sponsor-GitHub%20Sponsors-22c55e" alt="Sponsor Myco"></a>
  <img src="https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux-22c55e" alt="Runs on macOS and Linux">
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20Cursor%20%7C%20Cline%20%7C%20OpenCode%20%7C%20Pi-22c55e" alt="Claude Code | Codex | Cursor | Cline | OpenCode | Pi">
</p>

## What is Myco?

Myco is the nervous system for AI-assisted software teams. It captures what your coding agents do, turns it into durable project knowledge, and hands that knowledge back to every agent and teammate on the project.

Myco works alongside the agents you already use: Claude Code, Codex, Cursor, Cline, OpenCode and Pi. It does not replace their reasoning, memory or tools, and it does not tie your team to one of them.

Named after [mycorrhizal networks](https://en.wikipedia.org/wiki/Mycorrhizal_network), Myco is not another coding agent. It is the shared knowledge beneath the agents you have.

That distinction matters. A plain memory system keeps snapshots: what happened and what was said. Myco treats memory as living project material:

- a lesson that keeps coming back becomes one consolidated spore;
- an observation the code has moved past is superseded;
- a hard-won gotcha is waiting for the next agent that would have hit it.

The goal is the tribal knowledge a long-running team keeps in its heads, available to every new agent so it starts warm instead of cold.

## What Myco does

- **Captures the work.** Sessions, prompts, the work of each turn, and the plans your agents write.
- **Learns from it.** Myco's own agent reads what was captured and writes **spores**: decisions, gotchas, discoveries, trade-offs and fixes. It titles every session, curates spores as the code changes, learns from an existing project's code and history, and keeps a map of the code. See [How Myco learns](docs/intelligence.md).
- **Gives it back.** Relevant spores arrive with each prompt. Session-start instructions reach every agent, and seven MCP tools let an agent search and read everything the project knows. See [Agent tools](docs/agent-tools.md).
- **Shares it with the team.** Everyone's agents capture to one **server** and read from it, so what one person's agent learns, every agent on the team knows.

## Where it runs

Your team's knowledge lives on a server you run yourself. Myco's commands call it a **Deployment**, as in `myco server` flags and messages. There are two ways to run one, and the `myco` binary sets up either.

- **Hosted on Cloudflare.** There is no machine to keep running, and the free plan is enough for a small team.
- **Self-hosted.** Run it on your laptop or on a small virtual machine. It needs no container runtime and no Node.js.

See [Self-hosting](docs/self-hosting.md) to set one up.

## Install

On macOS or Linux:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh
myco login <invite link>
```

Then, in each repository you work in:

```bash
myco member join
```

1. The installer places the `myco` binary in `~/.myco/bin` and changes nothing else. Run it again to update; on a machine that is already signed in, it also refreshes your agents' Myco setup.
2. `myco login` signs the machine in with the invite link your server's administrator sent you. It sets up every coding agent installed on the machine to capture. On an administrator's machine it also starts the worker that runs Myco's own work; on the laptop that runs the server, restart the server instead (see [Self-hosting](docs/self-hosting.md#on-your-laptop)). Start a new session in each agent afterwards, so it picks up its hooks and Myco tools.
3. `myco member join` connects the repository to a project on the server. Pick an existing project, or add `--new` to create one named for the folder. Your agents' earlier sessions there come along.

From then on, every session in that repository is captured and titled. Once an administrator turns on **Learning** for the project and **Work on a schedule** for the server (it starts off), Myco turns those sessions into spores the whole team's agents start with. The [Quickstart](docs/quickstart.md) walks through both sides: setting up a server, and connecting a machine.

> **Coming in beta.1:** repositories under `~/Repos` will connect on their own the first time an agent works in them, so `myco member join` is only for repositories elsewhere ([#1547](https://github.com/goondocks-co/myco/issues/1547)). Myco 2.0 on Windows is coming too ([#1550](https://github.com/goondocks-co/myco/issues/1550)). Until then, the PowerShell installer (`install.ps1`) installs Myco 1.4.

### Coming from Myco 1.4

Myco 1.4 kept a vault on each laptop. Moving a machine to 2.0 brings every session, spore and plan it holds to your server, and leaves the 1.4 vaults untouched. See [Upgrading from 1.4](docs/upgrade-from-v1.md).

## The dashboard

Your server has a dashboard where the team sees what its agents did and what Myco made of it. **Today** shows the day's sessions and what Myco learned from them. **Sessions** has every conversation, turn by turn. **Knowledge** holds the project's spores, its plans and its code map. **Myco's work** shows what each of Myco's runs came to, and lets any member start one. Administrators also get **People & machines**, **Settings** and **Health**. See [The dashboard](docs/dashboard.md).

## Configuration

Everything is configured on the server's dashboard, for the whole team at once. That covers which model Myco's own work uses, what Myco does in each project, and what agents receive at session start. See [Configuration](docs/configuration.md).

## Health check

From a connected project:

```bash
myco doctor
```

It checks this machine's sign-in, the server, delivery, which agents capture, and the worker. See [Troubleshooting](docs/troubleshooting.md).

## Contributing

Contributions are welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and [the Myco 2.0 architecture](docs/architecture/myco-2.0.md) for how it fits together. Please open an issue to discuss before submitting a PR.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
