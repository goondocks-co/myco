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

Myco records your prompts, the agent's replies, its tool activity and plans as you work. Joining can also import earlier sessions, within the server's capture and retention settings.

Repositories under your capture folders (`~/Repos` by default) join automatically when an agent works in them. Elsewhere, use `myco member join` inside the Git repository. Change **Folders it captures** and **Extra plan folders** under **My machines**.

When the server cannot be reached, capture waits on the machine. `myco member status` shows queued delivery and refusals; `myco member drain` delivers queued capture now.

## Sessions that start other sessions

When one agent session starts another (an orchestrator launching a worker, or a script starting an agent), put the starting session's id in the new agent's `BAGGAGE` environment variable:

```sh
BAGGAGE="gen_ai.conversation.id=<your session id>" codex
```

Keep any other comma-separated baggage members. Replace an existing `gen_ai.conversation.id` member with your own id; percent-encode the id if it contains characters the [W3C Baggage format](https://www.w3.org/TR/baggage/) requires encoded.

Myco reads this member once, when the new session starts, and records the parent on that session. The session page's **Lineage** tab then shows both sessions in one family, with the parent above its children. Missing, malformed or conflicting baggage records no parent, and a resumed session keeps the parent it started with. A parent Myco never captured in that project shows as "A session not captured here". Myco only reads baggage; the launcher sets it.

Your id is on the `Session::` line Myco adds at session start. A Claude Code session can also pass its own `CLAUDE_CODE_SESSION_ID`, which is its Myco session id. Sub-agents that run inside one session need nothing: they are already part of it.

## What agents receive

Project instructions arrive at session start. Relevant spores and plans return with each prompt, and the [agent tools](agent-tools.md) let agents search further or record findings. The project's **Context for sessions** switch is on by default.

Cursor and OpenCode use a small local connection to reach Myco's tools. They read and write the same project knowledge as the other agents.

**Known limit:** with two Deployments on one machine, an agent's Myco tools may reach only one. Use `myco doctor` to check the setup ([#1724](https://github.com/goondocks-co/myco/issues/1724)).

## Who sees what

Processed project knowledge is available to members across the Deployment. Raw capture is private to its uploader. Your machine's name appears beside your own work; other members see the member's name. Administrators can see machine names on **People & machines** and **Health**.

Myco's own work requires a separately registered runner with a signed-in coding agent. Joining or provisioning a capture agent does not start a runner. See [Run your own Myco](self-hosting.md).
