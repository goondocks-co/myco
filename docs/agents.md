# Agents

Myco works beside the coding agents you already use. It records what they do and gives them back what the team knows. It does not replace their memory, their tools or the way they work.

## Agents that capture

| Agent | Name to use |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| Cursor | `cursor` |
| Cline | `cline` |
| OpenCode | `opencode` |
| Pi | `pi` |

Antigravity, Copilot and Windsurf are not captured by Myco 2.0. They can still read a project's knowledge through an access key; see [External agents](external-agents.md).

## Connect an agent

`myco login` sets up every agent on this list that is installed on the machine, so most people never connect one by hand. An agent whose settings belong to another Myco installation is left as it is, and `myco login` names it.

To connect an agent you installed later, or to repair one, run:

```bash
myco member provision claude-code
```

With no agent named, `myco member provision` sets up every agent installed on the machine. Running it again is safe.

Start a new session in an agent after it is set up. An agent that was already open picks up its hooks and Myco tools at its next start.

Provisioning is for the whole machine, not one project. It writes the agent's own user-level settings. For Claude Code these are `~/.claude/settings.json` (hooks) and `~/.claude.json` (the MCP entry). For Codex they are `~/.codex/hooks.json` and `~/.codex/config.toml`. The hooks run `myco`, and the MCP entry points at your server's `/mcp` address. Both ask `myco` for the machine's sign-in when they run, so no token is written into the agent's files.

The hooks then run in every folder you open. In a repository you connected with `myco member join`, they capture. In any other folder they capture nothing, and say so.

> **Coming in beta.1:** repositories under `~/Repos` will connect on their own the first time an agent works in them, and a repository that cannot connect will show as **Not captured** on your **Today**, with a way to connect it, instead of being skipped quietly ([#1547](https://github.com/goondocks-co/myco/issues/1547)).

Moving from Myco 1.4? `myco cutover` sets up every agent it finds for you and takes 1.4 out of each; see [Upgrading from 1.4](upgrade-from-v1.md).

## What is captured

Each agent's hooks send the session's start and end, every prompt, and the turn's work, including any plan the agent wrote. The agent's transcript follows, and the server reads the full session from it. A machine that joins also brings its agents' earlier sessions, as far back as the server allows (see [Configuration](configuration.md)).

When the server cannot be reached, events wait on the machine and are delivered when it answers again. `myco member status` shows what is waiting, and `myco member drain` delivers it now.

### Who sees what

Every member of the server can read every project's sessions, spores and plans. A session shows which member it came from. Your machine's name, which is its host name, is shown to you beside your own work; other members see your work as from you. Administrators see every machine's name only on **People & machines** and **Health**. On Today, Sessions and Myco's work, even an administrator sees another member's work as **from** that member. See [The dashboard](dashboard.md#machine-names).

## Agents as workers

An administrator's machine also lends one of its agents to Myco's own work: Claude Code, Codex, OpenCode, Cursor or Antigravity, whichever is installed and signed in. See [How Myco learns](intelligence.md).
