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
| GitHub Copilot CLI | `copilot` |
| Google Antigravity | `antigravity` |
| Windsurf | `windsurf` |

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
| Copilot CLI | `~/.copilot/hooks/myco-hooks.json` | `~/.copilot/mcp-config.json` |
| Antigravity | `~/.gemini/config/hooks.json` (named `myco` block) | `~/.gemini/config/mcp_config.json` |
| Windsurf | `~/.codeium/windsurf/hooks.json` | `~/.codeium/windsurf/mcp_config.json` |

Shipped skills are linked to the agent's live skills location:

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/skills` |
| Codex, Cursor, OpenCode, Pi, Copilot CLI and Windsurf | `~/.agents/skills` |
| Antigravity | `~/.gemini/config/skills` |
| Cline | `~/.cline/skills` |

### Several accounts for one agent

Some agents let you keep a settings folder per account and choose one with a variable: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`), Copilot CLI (`COPILOT_HOME`), Pi (`PI_CODING_AGENT_DIR`) and Cline (`CLINE_DIR`). Myco sets up each such folder the way it sets up the default one, and the paths in the tables above move into that folder. Claude Code's tools configuration moves too, to `.claude.json` inside the folder. Shared locations such as `~/.agents/skills` stay where they are.

Myco finds a folder when:

- the agent's variable names it in the shell you run Myco from;
- it sits directly in your home folder and holds the files the agent writes there on its first run (for Claude Code, `.claude.json`);
- you name it: `myco member provision claude-code --settings-folder ~/accounts/claude-work`.

`myco doctor` lists each folder it captures from, and names any folder it found but has not set up. `myco member provision --refresh` sets those up; the automatic refresh does too. Cursor, OpenCode, Antigravity and Windsurf keep one settings folder each.

To disconnect one agent:

```bash
myco member provision --remove claude-code
```

This removes that agent's Myco hooks, tools and skill links from every settings folder Myco set up for it. A shared skills folder keeps its links while another connected agent uses it. To sign the whole machine out, use `myco logout <address>`; see [Leaving a Myco](quickstart.md#leaving-a-myco).

## What is captured

Myco records your prompts, the agent's replies, its tool activity and plans as you work. Joining can also import earlier sessions, within the server's capture and retention settings.

Repositories under your capture folders (`~/Repos` by default) join automatically when an agent works in them. Elsewhere, use `myco member join` inside the Git repository. Change **Folders it captures** and **Extra plan folders** under **My machines**.

When the server cannot be reached, capture waits on the machine. `myco member status` shows queued delivery and refusals; `myco member drain` delivers queued capture now.

## Copilot CLI, Antigravity and Windsurf limits

These agents use the same login, provision and logout commands above. Copilot means the terminal CLI; provisioning it leaves VS Code's configuration alone. Antigravity is detected by the `agy` command on PATH. Windsurf’s English documentation now redirects to Devin Desktop, which uses a different hooks file; Myco follows the installed Windsurf IDE’s contract. Doctor shows connected hooks and their limits on one line. Connected configuration does not prove a session has reached Myco.

The matrix separates available contracts from live verification. The supported paths below have isolated configuration and payload tests. Copilot CLI also recognizes the installed MCP entry and lists the Myco skills; Antigravity CLI recognizes its MCP entry. Cells marked "live" were observed on one real session each on 2026-11-16 (Copilot CLI 1.0.106-6, Antigravity CLI 1.5.9, macOS). The Deployment parses both harnesses’ uploaded transcripts; the parser supplies prompts and replies, and Copilot tool results. Antigravity tools remain hook-captured because its transcript results have no call key. MCP calls and skill use still need a session that exercises them; no account sign-in or real Deployment was used for this verification.

| Capability | Copilot CLI | Antigravity | Windsurf |
|---|---|---|---|
| Session start context | unverified: the hook runs and the session start is recorded; whether the model sees the context is not observable from capture [C-hooks] | yes: the injected step is in the conversation (live, CLI 1.5.9) [A-hooks] | no: no session-start hook [W-hooks] |
| Prompt-time memory | unverified: hook docs say output is dropped; CLI 1.0.65 release notes say included [C-hooks], [C-releases] | not wired: PreInvocation carries lastUserInput and accepts injectSteps [A-hooks] | no: prompt hook has no model-context output [W-hooks] |
| Late memory at the first tool call | yes: delivered at the first tool call of the same prompt (live, CLI 1.0.106-6) [C-hooks], [recall] | no: tool-hook output carries no context [A-hooks] | no: tool hooks have no model-context output [W-hooks] |
| Prompt capture | yes: prompt hook (live) [C-hooks] | yes: transcript backfill (live) [backfill] | unverified: installed, signed-in app needed; prompt hook [W-hooks] |
| Tool-call capture | yes: input and result (live) [C-hooks] | yes: name and input, no result body (live) [A-hooks] | unverified: installed, signed-in app needed; read/write/command/MCP hooks [W-hooks] |
| Response capture | Deployment reads assistant messages from the transcript shipped at Stop [C-events], [transcripts] | Deployment reads planner replies from the transcript shipped at Stop [A-hooks], [transcripts] | unverified: installed, signed-in app needed; response hook [W-hooks] |
| Transcript import | Deployment parses uploaded event logs incrementally; earlier history still needs Project attribution [C-events], [import] | Deployment parses uploaded step logs incrementally; earlier history still needs Project attribution [A-hooks], [import] | unverified: transcript Project attribution needed [import] |
| Session end | yes: SessionEnd (live) [C-hooks] | no: no session-end hook; Stop ends an execution [A-hooks] | no: no session-end hook; response hooks end turns [W-hooks] |
| MCP tools | unverified: signed-in CLI and reachable Myco needed [C-mcp] | unverified: signed-in agent and reachable Myco needed [A-mcp] | unverified: installed, signed-in app and reachable Myco needed [W-mcp] |
| Skills | unverified: model invocation needs sign-in; CLI discovery passes [C-skills] | unverified: agent discovery needed [A-skills] | unverified: app discovery needed [W-skills] |

Copilot receives prompt recall at a completed tool hook: a signed-in machine's helper fetches it, and under an environment credential the prompt hook fetches it within its time bound and holds it for that tool hook. It counts as delivered only when the tool hook prints it. Prompt-hook injection remains unverified because the hook documentation and CLI release notes disagree. A turn with no tool call receives no prompt recall. Native prompt links look back at most 1 MiB through complete JSONL records, stopping once the source key is found; a missing, unreadable or ambiguous source leaves the delivered memory unscoped. Antigravity reads prompts from its transcript by source step identity; it injects the session block through SessionStart or PreInvocation once per conversation. Windsurf captures through its hooks and transcript while knowledge is available on demand through MCP and skills. Missing injection hooks do not block any session.

Transcripts are shipped at turn end. Earlier on-disk transcripts are discovered, but these three manifests declare no trustworthy Project attribution field, so automatic history import reports them as unattributable. It does not assign them to the current folder. Antigravity and Windsurf lack an explicit session-end hook; server idle closure remains available.

[C-events]: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events
[C-hooks]: https://docs.github.com/en/copilot/reference/hooks-reference
[C-releases]: https://github.com/github/copilot-cli/releases/tag/v1.0.65
[C-mcp]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
[C-skills]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
[A-hooks]: https://antigravity.google/docs/hooks
[A-mcp]: https://antigravity.google/docs/mcp
[A-skills]: https://antigravity.google/docs/skills
[W-hooks]: https://docs.windsurf.com/de/windsurf/cascade/hooks
[W-mcp]: https://docs.windsurf.com/de/windsurf/cascade/mcp
[W-skills]: https://docs.windsurf.com/de/windsurf/cascade/skills
[recall]: https://github.com/goondocks-co/myco/blob/main/packages/myco/src/member/prompt-context.ts
[backfill]: https://github.com/goondocks-co/myco/blob/main/packages/myco/src/member/transcript-prompts.ts
[transcripts]: https://github.com/goondocks-co/myco/blob/main/packages/myco/src/hooks/stop.ts
[import]: https://github.com/goondocks-co/myco/blob/main/packages/myco/src/member/import.ts

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

For connected projects on a machine with two Deployments, Claude Code uses private project entries in its user configuration, keyed by the canonical repository root shared by subfolders and worktrees. Codex resolves tools from the session folder. Claude Code accepts trust for the project or an ancestor folder; Myco leaves that trust decision to you. After a repository auto-joins, its waiting session receives a notice to reconnect Myco tools with `/mcp`. Doctor names each project's tools destination and any missing trust. Cursor and OpenCode still have the routing limit above.

## Who sees what

Processed project knowledge is available to members across the Deployment. Raw capture is private to its uploader. Your machine's name appears beside your own work; other members see the member's name. Administrators can see machine names on **People & machines** and **Health**.

Myco's own work requires a separately registered runner with a signed-in coding agent. Joining or provisioning a capture agent does not start a runner. See [Run your own Myco](self-hosting.md).
