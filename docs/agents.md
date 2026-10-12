# Agents

Myco works beside the coding agents you already use. It records their sessions and gives them back what the project knows. It does not replace their memory, tools or way of working.

## Agents that capture

| Agent | Name to use |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| Cursor | `cursor` |
| OpenCode | `opencode` |
| Pi | `pi` |
| Cline | `cline` |

Other agents can use project knowledge through an access key; see [External agents](external-agents.md). Capture support and running Myco's own tasks are different: runners can use Claude Code, Codex, OpenCode, Cursor or Antigravity.

## Connect an agent

`myco login <address>` sets up every capture agent it finds installed on the machine. An agent whose settings belong to another Myco installation is left alone and named. See [Join a Myco](quickstart.md) for sign-in and approval.

To connect an agent installed later, or repair its setup:

```bash
myco member provision claude-code
```

With no agent named, `myco member provision` sets up all detected agents. Running it again is safe. Start a new agent session afterward.

Provisioning writes each agent's **global user configuration**, shared across repositories. It preserves other settings. It does not require a project-local `.agents/` folder. `--root` selects the repository's membership; it does not change installation scope.

| Agent | Capture configuration | Myco tools configuration |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `~/.claude.json` |
| Codex | `~/.codex/hooks.json` | `~/.codex/config.toml` |
| Cursor | `~/.cursor/hooks.json` | `~/.cursor/mcp.json` |
| OpenCode | `~/.config/opencode/plugins/myco.ts` | `~/.config/opencode/opencode.json` |
| Pi | `~/.pi/agent/extensions/myco/index.ts` | The extension |
| Cline | `~/.cline/plugins/myco.ts` | Cline's global MCP settings |

Shipped skills are linked to the agent's live skills location:

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/skills` |
| Codex, Cursor, OpenCode and Pi | `~/.agents/skills` |
| Cline | `~/.cline/skills` |

To disconnect one agent:

```bash
myco member provision --remove claude-code
```

This removes that agent's Myco configuration. To sign the whole machine out, use `myco logout <address>`; see [Leaving a Myco](quickstart.md#leaving-a-myco).

## What is captured

Myco captures prompts, replies, tool activity and plans from the agent's session transcript. Hooks announce session activity and arrange transcript delivery. Joining can also import earlier sessions, within the server's capture and retention settings.

Repositories under your capture folders (`~/Repos` by default) join automatically when an agent works in them. Elsewhere, use `myco member join --no-worker` inside the Git repository. Change **Folders it captures** and **Extra plan folders** under **My machines**.

When the server cannot be reached, capture waits on the machine. `myco member status` shows queued delivery and refusals; `myco member drain` delivers queued capture now.

## What agents receive

Project instructions arrive at session start. Relevant spores and plans return with each prompt, and the [agent tools](agent-tools.md) let agents search further or record findings. The project's **Context for sessions** switch is on by default.

Cursor and OpenCode use a local stdio bridge to the server's MCP tools. They still read and write the same project knowledge on the server.

**Known limit:** with two Deployments on one machine, an agent's single Myco MCP entry may reach only one. Use `myco doctor` to check the setup ([#1724](https://github.com/goondocks-co/myco/issues/1724)).

## Who sees what

Processed project knowledge is available to members across the Deployment. Raw capture is private to its uploader. Your machine's name appears beside your own work; other members see the member's name. Administrators can see machine names on **People & machines** and **Health**.

Myco's own work requires a separately registered runner with a signed-in coding agent. Joining or provisioning a capture agent does not start a runner. See [Run your own Myco](self-hosting.md).
