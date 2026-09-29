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
- **Learns from it.** Myco's own agent reads what was captured and writes **spores**: decisions, gotchas, discoveries, trade-offs and fixes. It titles every session, curates spores as the code changes, seeds an existing project from its code and history, and keeps a map of the repository. See [How Myco learns](docs/intelligence.md).
- **Gives it back.** Relevant spores arrive with each prompt. Session-start instructions reach every agent, and seven MCP tools let an agent search and read everything the project knows. See [Agent tools](docs/agent-tools.md).
- **Shares it with the team.** Everyone's agents capture to one **Deployment** and read from it, so what one person's agent learns, every agent on the team knows.

## Where it runs

Your team's knowledge lives on a Deployment: a server you run yourself. There are two ways to run one, and the `myco` binary sets up either.

- **Hosted on Cloudflare.** There is no machine to keep running, and the free plan is enough for a small team.
- **Self-hosted.** Run it on your laptop or on a small virtual machine. It needs no container runtime and no Node.js.

See [Self-hosting](docs/self-hosting.md) to set one up.

## Install

On macOS or Linux:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh
myco login <invite link>
myco member provision claude-code
```

1. The installer places the `myco` binary in `~/.myco/bin` and changes nothing else.
2. `myco login` signs the machine in with the invite link your Deployment's administrator sent you.
3. `myco member provision` gives an agent its capture hooks and Myco tools.

Once a project on the machine is connected, its sessions are captured. The [Quickstart](docs/quickstart.md) walks through both sides, setting up a Deployment and connecting a machine, and lists the [known gaps](docs/quickstart.md#known-gaps) in today's flow.

On Windows, the PowerShell installer (`install.ps1`) still installs Myco 1.4; there is no 2.0 installer for Windows yet.

### Coming from Myco 1.4

Myco 1.4 kept a vault on each laptop. Moving a machine to 2.0 brings every session, spore and plan it holds to your Deployment, and leaves the 1.4 vaults untouched. See [Upgrading from 1.4](docs/upgrade-from-v1.md).

## Configuration

Everything is configured on the Deployment's dashboard, for the whole team at once. That covers which model provider Myco's agent uses, what each project gets, and what agents receive at session start. See [Configuration](docs/configuration.md).

## Health check

From a connected project:

```bash
myco doctor
```

It checks the membership, the Deployment, the credential, delivery, which agents capture, and the worker. See [Troubleshooting](docs/troubleshooting.md).

## Contributing

Contributions are welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and [the Myco 2.0 architecture](docs/architecture/myco-2.0.md) for how it fits together. Please open an issue to discuss before submitting a PR.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
