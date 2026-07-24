# Team Host

Team Host turns one teammate's Myco install into your team's shared home. Join it from any other machine, connect your projects, and every teammate's agents draw on the same team storage — search, spores, sessions, plans, and skills — over a direct, encrypted connection between your machines. No cloud account, no third-party service holding your data.

> **Coming from Team Sync?** Team Sync — the earlier Cloudflare-based sync worker — is retired. Move your team to Team Host by having one teammate run a team server (see [Run a team server](#run-a-team-server) below) and everyone else joining it; there's no cloud account to provision this time. Any Team Sync worker you deployed earlier keeps running as it is, without further updates. Your local knowledge was never stored on it, so nothing is at risk either way. When you connect a project that already has local history, that history moves into team storage too — see [Connect a project](#connect-a-project).

## What you get

- One teammate's machine becomes the team's shared home — everyone else joins it and connects their projects.
- Joined machines and the host talk directly over an encrypted overlay connection, peer-to-peer where possible.
- New spores, sessions, plans, and other knowledge on a connected project reach team storage as you work.
- A read-only endpoint lets tools that aren't Myco members — hosted agents, automations — query team storage too.
- Team storage is the sole copy for anything routed through it, so a serve install backs it up automatically.

## Join a team

Open the dashboard (`myco open`) and go to the **Team** page. Under **Join a Team Host**, enter the host id, one-time key, server URL, and overlay address a host operator shared with you, then submit. Myco enrolls this machine, and the join form confirms whether the host is reachable yet.

Prefer the terminal, or scripting a new machine's setup? `myco join <host> --key <one-time-key> --server-url <url> --overlay-address <address>` does the same enrollment and prints the connection details: a local proxy address, this machine's address on the team's overlay, and whether the host answered.

To disconnect this machine from a host entirely, use **Leave host** on the Team page or run `myco leave <host>`.

## Connect a project

Joining a host doesn't route any project traffic by itself — connect each project you want served by the team individually, from the Team page's **Route a project through a Team Host** panel or with `myco attach [path] --host <id>`. You don't supply team storage — the host reports the team storage it serves, and your project routes there automatically. From then on, new work on that project reaches team storage as you go.

### Connecting a project that has history

If the project already has its own local Myco history, connecting it moves that history to the team — one action, no separate migration step. Myco saves a local backup of the project first, so you always keep your own copy, then hands the project's knowledge to team storage.

The move is honest about what travels: sessions from before you connected keep their knowledge — their titles, summaries, and the spores, plans, and skills drawn from them — while the blow-by-blow detail of those older sessions stays in your local backup. Everything from the moment you connect onward is captured in full.

## Disconnect a project

`myco detach [path]`, or the **Detach** control next to a connected project on the Team page, routes that project back to local-only. Your machine's own contributions come back to you, and the team keeps its copy — disconnecting is a copy-out, not a handover, so nothing the team already learned from the project is lost. Future work on that project stays on your machine until you connect it again.

If the host is on an older version of Myco that can't return your data yet, Myco tells you and lets you disconnect anyway — that stops the project routing to team storage right away, without pulling your contributions back. Update the host, then disconnect again to retrieve them.

## Keeping Myco up to date

When you update Myco across the team, update the host first, then the members. A member that updates ahead of the host keeps working — its captured work waits on that machine and delivers as soon as the host catches up, so nothing is lost — but connecting a project with history, or disconnecting to pull your data back, needs the host on the newer version first.

## Team settings and the agent key

The Team page's settings section edits configuration for team storage itself — pick "This machine" if you're the host, or the host you want to configure if you're a member with an attached project. Provider, embedding, and per-task overrides here apply to every project connected through that host, the same forms you'd use for a single project's own settings.

The agent that does background work against team storage needs its own provider key, separate from anything configured on individual machines. Set it once — at install time with `--team-key` (or the `MYCO_TEAM_AGENT_KEY` environment variable), or later from any member's Team page — and it lives in the host's team storage. Your own personal provider keys are never used for team work, and the team key never leaves team storage.

## Capture delivery

The Team page's **Capture delivery** panel shows, per host, how much captured work — transcripts, plans, live session events — is still pending delivery and how much is failing. It's the place to check if a teammate says their work "isn't showing up" on team storage yet.

## External read-only MCP

Tools that never join the team's overlay — a hosted agent, an automation platform, anything that speaks [Model Context Protocol](https://modelcontextprotocol.io) — can still read team storage through a separate, read-only endpoint. It exposes exactly six tools: search, a project digest, and list/get on plans, sessions, skills, and spores — nothing that writes, and nothing beyond what's already read-only for a Myco member.

The endpoint is reached over a public HTTPS URL (a Tailscale Funnel address) on port 8743 by default, gated by a bearer token. Enabling the listener today is API-driven rather than a dashboard switch — there's no toggle on the Team page yet, so ask whoever manages your host to turn it on. Once it's running, the Team page's **External access** panel can rotate the token; rotating mints a fresh value immediately and invalidates the old one, so every tool already configured needs updating afterward. The panel confirms a rotation happened, but doesn't display the token text itself — the host admin provides the token value when they enable external access. `myco doctor` flags it if the listener is turned on with no token to authenticate callers.

Point any MCP-speaking tool at the endpoint with a bearer header, for example:

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://<your-funnel-url>/mcp",
      "name": "myco",
      "authorization_token": "<TOKEN>"
    }
  ]
}
```

## Backups

Team storage is the one copy of everything routed through it, so a serve install turns on scheduled local backups for it by default — the same backup mechanism every Myco project uses, just applied automatically here. Run a backup on demand, or configure the schedule and retention, from the **Backup & Restore** section of the Settings page.

If a serving machine needs replacing, restore its backup onto the replacement using the same restore flow any Myco project uses — restore supports a dry-run preview first, and preserves attribution so nothing about who-said-what is lost in the move.

## Run a team server

Turning a machine into a Team Host is an operator action — do this on the machine you want your team to depend on.

The simplest path is at install time:

```bash
curl -fsSL https://myco.sh/install.sh | sh -s -- --serve --server-url https://your-host:8080
```

`--serve` requires `--server-url` — the address teammates will dial to reach this host. It designates this machine's default project storage as what it serves for the team, and prints a ready-to-paste `myco join …` command for your first teammate. This installer flag is available on macOS and Linux; Windows hosts aren't supported yet.

Already installed? `myco host enable --server-url <url>` does the same enrollment on an existing install. It provisions and starts the overlay networking services this machine needs to serve a team, and requires root — expect a sudo prompt. From there:

- `myco host status` — this machine's current Team Host state.
- `myco host rotate-key` — mint a fresh one-time key and print the ready-to-paste join command for the next teammate. Runs only on the host's own machine; it's never reachable by team members over the overlay.
- `myco host disable` — stop serving and tear down the overlay services.

## How the network works

The control plane — the piece that lets machines find and authenticate each other — runs on the host operator's own machine, not on infrastructure Myco or anyone else operates. Once two machines know about each other, they connect directly over an encrypted WireGuard link; that's the normal case. When a direct connection isn't possible (both machines behind restrictive NAT, for example), traffic falls back to relaying through Tailscale Inc's public relay network — the one piece of this that isn't self-hosted, kept deliberately off by default as the host's own single point of failure and used only as a last resort. There's no automatic naming/discovery layer beyond what the overlay itself provides, and the public Funnel URL is used for exactly one thing: fronting the external read-only MCP endpoint above. Nothing else about your team's connection is exposed publicly.
