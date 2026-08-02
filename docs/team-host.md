# Team Host

Team Host turns one teammate's Myco install into your team's shared home. Join it from any other machine, connect your projects, and every teammate's agents draw on the same team storage — search, spores, sessions, plans, and skills — over a direct, encrypted connection between your machines. No cloud account, no third-party service holding your data.

> **Coming from Team Sync?** Team Sync — the earlier Cloudflare-based sync worker — is retired. Move your team to Team Host by having one teammate run a team server (see [Run a team server](#run-a-team-server) below) and everyone else joining it; there's no cloud account to provision this time. Any Team Sync worker you deployed earlier keeps running as it is, without further updates. Your local knowledge was never stored on it, so nothing is at risk either way. When you connect a project that already has local history, that history moves into team storage too — see [Connect a project](#connect-a-project).

## What you get

- One teammate's machine becomes the team's shared home — everyone else joins it and connects their projects.
- Joined machines and the host talk directly over an encrypted overlay connection, peer-to-peer where possible.
- New spores, sessions, plans, and other knowledge on a connected project reach team storage as you work.
- A read-only endpoint lets tools that aren't Myco members — hosted agents, automations — query team storage too.
- Team storage is the sole copy for anything routed through it, so a serve install backs it up automatically.

## Before you start

Team Host runs on **macOS and Linux**, for hosts and members alike. Windows can't take part yet — not as a host and not as a member — because the overlay client Myco provisions has no Windows build. Everything else in Myco works normally on Windows; it's team membership specifically that's unavailable.

On **macOS**, Myco needs [Homebrew](https://brew.sh) to install the overlay client, on hosts and members both. The open-source overlay client ships through Homebrew on macOS and nowhere else, so `myco join` and `myco install --serve` will stop and tell you if it's missing. On Linux there's no such requirement — Myco downloads and verifies the client itself.

## Join a team

Open the dashboard (`myco open`) and go to the **Team** page. Under **Join a Team Host**, enter the host id, one-time key, server URL, and overlay address a host operator shared with you, then submit. Myco enrolls this machine, and the join form confirms whether the host is reachable yet.

Prefer the terminal, or scripting a new machine's setup? `myco join <host> --key <one-time-key> --server-url <url> --overlay-address <address>` does the same enrollment and prints the connection details: a local proxy address, this machine's address on the team's overlay, and whether the host answered.

To disconnect this machine from a host entirely, use **Leave host** on the Team page or run `myco leave <host>`. Leaving is refused while any of your projects is still connected to that host — disconnect each first (`myco detach`) — and while a project move is in flight, so your data can never be stranded on a host you've left.

## Connect a project

Joining a host doesn't route any project traffic by itself — connect each project you want served by the team individually, from the Team page's **Route a project through a Team Host** panel or with `myco attach [path] --host <id>`. You don't supply team storage — the host reports the team storage it serves, and your project routes there automatically. From then on, new work on that project reaches team storage as you go.

### Connecting a project that has history

If the project already has its own local Myco history, connecting it moves that history to the team — one action, no separate migration step. Myco saves a local backup of the project first, so you always keep your own copy, then hands the project's knowledge to team storage.

The move is honest about what travels: sessions from before you connected keep their knowledge — their titles, summaries, and the spores, plans, and skills drawn from them — while the blow-by-blow detail of those older sessions stays in your local backup. Everything from the moment you connect onward is captured in full.

## Disconnect a project

`myco detach [path]`, or the **Detach** control next to a connected project on the Team page, brings that project back to local-only. The project's knowledge — everything the team has learned in it, as of the moment you disconnect — comes back to this machine, and a backup copy of it is saved alongside your other backups. The team keeps its copy too: disconnecting is a copy-out, not a handover, so nothing the team already learned from the project is lost. The move finishes in the background (watch the Team page); new work goes local once it lands.

If the host is on an older version of Myco that can't return your data yet, Myco tells you and lets you disconnect anyway — that stops the project routing to team storage right away, without pulling your contributions back. Update the host, then disconnect again to retrieve them.

## Keeping Myco up to date

Finish (or cancel) any in-flight project move before updating either machine — a move started on an older version can't be continued by a newer one; it will ask you to cancel and start it again. When you update Myco across the team, update the host first, then the members. A member that updates ahead of the host keeps working — its captured work waits on that machine and delivers as soon as the host catches up, so nothing is lost — but connecting a project with history, or disconnecting to pull your data back, needs the host on the newer version first.

## Team settings and the agent key

The Team page's settings section edits configuration for team storage itself — pick "This machine" if you're the host, or the host you want to configure if you're a member with an attached project. Provider, embedding, and per-task overrides here apply to every project connected through that host, the same forms you'd use for a single project's own settings.

The agent that does background work against team storage needs its own provider key, separate from anything configured on individual machines. Set it once — at install time with `--team-key` (or the `MYCO_TEAM_AGENT_KEY` environment variable), or later from any member's Team page — and it lives in the host's team storage. Your own personal provider keys are never used for team work, and the team key never leaves team storage.

## Capture delivery

The Team page's **Capture delivery** panel shows, per host, how much captured work — transcripts, plans, live session events — is still pending delivery and how much is failing. It's the place to check if a teammate says their work "isn't showing up" on team storage yet.

## External read-only MCP

Tools that never join the team's overlay — a hosted agent, an automation platform, anything that speaks [Model Context Protocol](https://modelcontextprotocol.io) — can still read team storage through a separate, read-only endpoint. It exposes exactly six tools: search, a project digest, and list/get on plans, sessions, skills, and spores — nothing that writes, and nothing beyond what's already read-only for a Myco member.

The endpoint is reached over a public HTTPS URL (a Tailscale Funnel address), gated by a bearer token. Turn it on from the Team page's **External access** panel — it's off by default, even on a serving install, until someone on the team explicitly enables it. Turning it on mints the access token and shows it **once**, with a copy button — save it then, because it isn't retrievable afterward. The public address is shown when you turn it on (any time later, `tailscale funnel status` on the host machine shows it). The same panel can rotate the token; rotating shows the new value once and invalidates the old one immediately, so every tool already configured needs updating afterward. Locally, the daemon serves this endpoint from a private socket owned by your user — there is no local TCP port another process could grab. External access requires the host's machine to run Tailscale with Funnel available (macOS and Linux only). `myco doctor` flags it if external access is enabled with no token to authenticate callers.

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

`--serve` requires `--server-url` — the address teammates will dial to reach this host. It designates this machine's default project storage as what it serves for the team, and prints a ready-to-paste `myco join …` command for your first teammate. This installer flag is available on macOS and Linux (see [Before you start](#before-you-start)).

Already installed? `myco host enable --server-url <url>` does the same enrollment on an existing install. It provisions and starts the overlay networking services this machine needs to serve a team, and requires root — expect a sudo prompt. From there:

- `myco host status` — this machine's current Team Host state.
- `myco host rotate-key` — mint a fresh one-time key and print the ready-to-paste join command for the next teammate. Runs only on the host's own machine; it's never reachable by team members over the overlay.
- `myco host disable` — stop serving and tear down the overlay services **completely**: the control plane, the host's overlay identity, and the credential members used to reach it are all destroyed. Re-enabling mints a fresh host identity, so teammates run `myco join` again and any external tools re-authenticate with a fresh token. If part of the teardown fails, nothing destructive happens — the state a retry needs is kept, and the command says exactly what survived.

### Choosing a host platform

A Linux host is the more reliable choice. On Linux, Myco fully manages the overlay client it installs — pinned version, verified content, converged automatically when you re-run `myco host enable`. On macOS, the overlay client comes from **your Homebrew** and Myco deliberately never upgrades or removes it: a `brew upgrade` can move it ahead of the version the control plane was tested with, and a `brew uninstall tailscale` stops the host (and every member session on the same machine — they share the one binary) with a silent respawn loop rather than an error. `myco doctor` flags both situations, but on macOS the fix is in your hands, not Myco's. Both platforms work; pick Linux when you can.

## How the network works

The control plane — the piece that lets machines find and authenticate each other — runs on the host operator's own machine, not on infrastructure Myco or anyone else operates. Once two machines know about each other, they connect directly over an encrypted WireGuard link; that's the normal case. When a direct connection isn't possible (both machines behind restrictive NAT, for example), traffic falls back to relaying through Tailscale Inc's public relay network — the one piece of this that isn't self-hosted, kept deliberately off by default as the host's own single point of failure and used only as a last resort. There's no automatic naming/discovery layer beyond what the overlay itself provides, and the public Funnel URL is used for exactly one thing: fronting the external read-only MCP endpoint above. Nothing else about your team's connection is exposed publicly.
