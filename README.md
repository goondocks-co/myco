<p align="center">
  <img src="docs/assets/myco-hero-wide.jpg" alt="Myco" width="100%">
</p>

<p align="center">
  <strong>The nervous system for AI-assisted software teams</strong>
</p>

<p align="center">
  <a href="https://github.com/goondocks-co/myco/actions/workflows/ci.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/goondocks-co/myco/actions/workflows/publish.yml"><img src="https://github.com/goondocks-co/myco/actions/workflows/publish.yml/badge.svg" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@goondocks/myco"><img src="https://img.shields.io/npm/v/@goondocks/myco?label=npm&color=22c55e" alt="npm"></a>
  <a href="https://github.com/goondocks-co/myco/blob/main/LICENSE"><img src="https://img.shields.io/github/license/goondocks-co/myco?color=22c55e" alt="License"></a>
  <a href="https://github.com/sponsors/goondocks-co"><img src="https://img.shields.io/badge/sponsor-GitHub%20Sponsors-22c55e" alt="Sponsor Myco"></a>
  <img src="https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-22c55e" alt="Runs on macOS, Linux, Windows">
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Cursor%20%7C%20Codex%20%7C%20Cline%20%7C%20Copilot%20%7C%20Antigravity%20%7C%20Devin%20Desktop%20%7C%20OpenCode%20%7C%20Pi-22c55e" alt="Claude Code | Cursor | Codex | Cline | Copilot | Antigravity | Devin Desktop | OpenCode | Pi">
</p>

## What is Myco?

Myco is the nervous system for AI-assisted software teams. It captures what happens across your coding sessions, turns raw memory into durable project knowledge, and routes the right context back to every agent and teammate working in the Grove.

Myco works automatically alongside the coding agents, subagents, and agent teams you already use. It does not replace their reasoning, memory, tools, or native workflows, and it does not lock you into one ecosystem.

Instead, Myco gives them an enhanced nervous system: richer senses, durable project knowledge, contextual recall of decisions and pitfalls, semantic codebase awareness, and learned workflows that compound across sessions and teammates.

Named after [mycorrhizal networks](https://en.wikipedia.org/wiki/Mycorrhizal_network), Myco is not another coding agent. It is the shared knowledge, signal layer, and coordination system beneath the agents you already use.

That distinction matters. Basic memory systems preserve snapshots: what happened, when it happened, and what was said. Myco treats memory as living project material. Some observations become obsolete as the code changes; repeated observations become wisdom; hard-won gotchas become reusable guidance. The goal is to preserve the tribal knowledge that used to live in the heads of long-running human teams, so each new coding agent can inherit accumulated context instead of starting cold.

That knowledge also evolves. Myco is not an ever-growing static archive. It keeps refining what the project knows, what the team has learned, and which workflows are still true. Because Myco lives with the project rather than inside any single coding agent or hosted harness, every connected agent can participate in that evolution without forcing your team into one AI ecosystem.

## What Myco does

- **Captures the work** — sessions, prompts, tool use, plans, screenshots, decisions, trade-offs, and gotchas.
- **Builds project knowledge** — durable **spores**, wisdom, summaries, digests, and searchable context.
- **Evolves what matters** — stale observations can be superseded, repeated lessons become wisdom, and workflows stay current as the code changes.
- **Routes context to agents** — session briefings, relevant spores, and Canopy file anatomy surface when agents need them.
- **Maps the codebase** — [Canopy](docs/canopy.md) gives agents semantic awareness of files before they open them.
- **Learns workflows** — repeated procedures become reviewed [skills](docs/skills.md) that every connected agent can follow.
- **Shares across teams** — an optional [Team Host](docs/team-host.md) connection routes a project's knowledge to a teammate's Myco directly and exposes it to non-member agents through a secure read-only MCP endpoint, no cloud account required.

## Install

macOS is the primary supported platform. Linux and Windows are in beta. On Windows, only **x64** is supported — Windows on ARM (which runs the x64 build under emulation) is not supported.

```bash
curl -fsSL https://myco.sh/install.sh | sh
myco open
```

On Windows x64 (PowerShell):

```powershell
irm https://myco.sh/install.ps1 | iex
```

Myco is a self-contained native binary — **no Node runtime required**. The installer downloads the binary to `~/.myco/bin` (`%LOCALAPPDATA%\Myco\bin` on Windows), starts the managed local service, and connects supported coding agents. Then `myco open` launches the dashboard. Open any git project in a supported coding agent and Myco auto-registers it into your default Grove when the agent starts working there.

You can also open the dashboard directly at [http://localhost:20915/](http://localhost:20915/). If your local install reports a different service URL, `myco open` will open the right one.

Already have Node? `npm install -g @goondocks/myco` also works — it's a thin bootstrap that converges to the same native binary.

Provider configuration is optional at install time. Capture and full-text search work immediately; spores, digests, semantic search, Canopy summaries, and skill lifecycle features become active after you configure intelligence and embedding providers in the dashboard.

See [Quickstart](docs/quickstart.md) for setup details and platform notes.

## Upgrade

Myco keeps itself up to date **automatically** — the local service self-updates from the release channel in the background while it's idle. You can also trigger an upgrade from the **Upgrade** section of the dashboard's **Settings** page.

No `npm update` is needed. (A `myco upgrade` CLI exists for advanced or scripted use, with `--channel stable|beta`, but the automatic and dashboard paths are the normal way to stay current.) Upgrading from an older per-project install archives legacy Myco-owned files the next time Myco starts. See [Upgrading Myco](docs/upgrade.md).

Team Host operator commands (`myco host`, `myco join`, `myco attach`) are part of the main binary and upgrade with it — no separate package.

## How it works

### Capture

Symbionts connect Myco to the agents you already use. They capture session starts, prompts, tool calls, stops, transcripts, and attachments into the Grove vault without replacing the agent's own memory or workflow.

### Intelligence

The [agent harness](docs/agent-harness.md) runs Myco's background intelligence work. It reads captured sessions, extracts **spores** (decisions, gotchas, discoveries, trade-offs, fixes), generates titles and summaries, links them to their source sessions, and refreshes digest extracts.

When Myco finds 3+ semantically similar spores, it synthesizes them into a **wisdom** spore — a higher-order observation that captures the pattern across sessions. Individual observations become institutional knowledge.

As the project changes, that knowledge keeps moving. New sessions can reinforce a pattern, replace an outdated assumption, or expose a workflow that should become shared practice.

Every task can use a different LLM provider. Run title generation on a fast local model via Ollama, extraction on Claude, and consolidation on a larger local model via LM Studio. Configure providers from the [dashboard](#dashboard).

See the [Intelligence Pipeline docs](docs/agent-harness.md) for the task catalog, provider configuration, and scheduling.

### Digest

The digest synthesizes accumulated knowledge into tiered **extracts** — pre-computed context at different depths:

| Tier | Purpose |
|------|---------|
| **1,500 tokens** | Executive briefing — what this project is, what's active, what to avoid |
| **5,000 tokens** | Deep onboarding — trade-offs, patterns, team dynamics |
| **10,000 tokens** | Institutional knowledge — full thread history and design tensions |

Extracts refresh in the background as new knowledge arrives. When the project goes quiet, refresh slows; new sessions wake it back up.

### Search

Every record is indexed for both keyword search and semantic similarity. Use [Ollama](https://ollama.com) locally for embeddings, or [OpenRouter](https://openrouter.ai) / [OpenAI](https://platform.openai.com) in the cloud. The index is fully rebuildable from the database.

### Canopy — codebase awareness

Myco keeps a fresh per-file index of your project — exports, imports, top comment, optional one-line summary — and hands the agent that anatomy before it opens a file. A single `myco_cortex` call with `op: "canopy_map"` returns the project's architectural overview, so a new agent can orient in one tool call instead of a dozen searches. Manage it from the dashboard's **Cortex** tab. See the [Canopy docs](docs/canopy.md).

### Context injection

Myco routes project context to agents automatically:

- **Session start** — a project briefing gives the agent pre-computed project understanding before it asks a single question.
- **Per-prompt** — relevant spores are retrieved after user prompts, providing targeted context for the task at hand.
- **Pre-read** — Canopy file anatomy appears before reads so agents can choose the right file faster.

Agents can still use their own memory and tools. Myco adds shared project context without taking those systems over.

### Dashboard

A local web dashboard provides configuration and operations management. Manage Groves and projects, configure providers, approve skill candidates, trigger intelligence and digest cycles, monitor service health, and view live logs.

Use the [Grove Management guide](docs/groves.md) to decide when to create additional Groves, move or archive projects, and toggle per-project capabilities such as Cortex, Canopy, Skills, and Vault Evolution.

### Symbionts

Myco integrates with coding agents through **symbionts**. Each symbiont connects Myco to an agent's native context, tools, skills, and permissions while preserving that agent's own workflow.

Supported symbionts include Claude Code, Cursor, Codex, Cline, Copilot, Antigravity, Devin Desktop, OpenCode, and Pi. See the [Symbiont docs](docs/symbionts.md) for agent-specific details.

### Team Host

Share knowledge across machines and teammates with no cloud account. One teammate's Myco becomes the team's shared home; everyone else joins it directly from the dashboard:

```bash
myco host enable --server-url https://your-host:8080   # on the host machine
myco join <host> --key <one-time-key> --server-url <url> --overlay-address <address>   # on a member's machine
```

Both steps are also available from the dashboard's **Team** page — enabling a host prints a ready-to-paste join command, and joining is a form with the same four fields. Once joined, connect the projects you want the team to share (Team page, or `myco attach [path] --host <id>`). Connecting a project moves its knowledge — sessions, spores, plans, skills — to the host, which holds the single copy while the project is connected; agent tools and search route to it transparently. Disconnecting (`myco detach`) brings the full history back home in one verified transfer.

For projects you haven't connected to a host, your local Grove databases remain the source of truth. Joined machines and the host talk over a direct, encrypted overlay connection, and each record carries a machine identity for attribution.

See the [Team Host docs](docs/team-host.md) for the full guide, including running a team server and the external read-only MCP endpoint for agents that aren't Myco members.

### Collective

The Collective — a cross-team admin layer — is not currently integrated with Myco; it's kept as a design record pending a redesign around Team Host. See the [Collective notes](docs/collective.md) for its status.

### External read-only MCP

A Team Host can also expose a read-only, six-tool MCP endpoint over a secure public URL — for agents that aren't Myco members, like managed agents and automation platforms. Connect any tool that speaks MCP and it gets read access to the same team knowledge your local agents already have. See the [Team Host docs](docs/team-host.md#external-read-only-mcp) for the tool reference and setup.

### Skills — automated curation, not just memory

Memory is table stakes. Myco goes further: it turns accumulated project knowledge into **repeatable workflows** that every agent follows. The intelligence pipeline identifies procedural patterns across sessions — debugging the build, adding API routes, configuring providers, resolving common gotchas — and surfaces them as candidates. You approve what becomes canon; Myco generates and validates the skill, and when you **Publish** it, the SKILL.md file lands in your project under `.agents/skills/`, symlinked into every agent's native skills directory.

Skills evolve as your code does. When a pattern is abandoned, a new gotcha is discovered, or a workflow shifts, Myco refreshes affected skills — preserving what's still accurate, incorporating what's new, and splitting skills that have grown too broad. See the [Skills docs](docs/skills.md) for the full lifecycle.

### Backup & restore

Backups and restores are Grove-scoped. Local backups run automatically during idle periods, and destructive project deletion creates a fresh Grove backup first when backups are enabled. Configure a custom backup directory in the **Backup & Restore** section of the Settings page. Restore preserves existing records and avoids importing duplicates.

## Health check

```bash
myco doctor
```

Verifies your local Myco install, Grove data, provider setup, connected agents, service status, and dashboard access. Use `--fix` to auto-repair fixable issues.

## Uninstall

```bash
myco remove           # removes Myco's contributions from every agent's global config
myco remove --purge   # also removes ~/.myco/ itself
```

Removal preserves any user-pre-existing keys in agent config files (e.g. a Codex `[features].hooks` entry you added yourself stays put).

## Contributing

Contributions welcome. See the [Contributing Guide](CONTRIBUTING.md) for development setup, and the [Lifecycle docs](docs/lifecycle.md) for architecture details. Please open an issue to discuss before submitting a PR.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
