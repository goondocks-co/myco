# Running your own Myco server

Myco's server is one file. It holds your team's sessions, spores and plans, answers your coding agents over MCP, and schedules the work that turns transcripts into knowledge. You can run it on the laptop you already code on, or on a small virtual machine your team shares.

It needs no container runtime, no Node.js, and no source checkout. The `myco` binary you already installed is the server.

## On your laptop

```bash
myco server create --target local
myco server install --target local
```

The first command makes the server's directory, generates the keys it protects your credentials with, and prepares its storage. The second makes it start whenever you log in and come back if it stops.

Your server lives at `http://127.0.0.1:8787` and listens only on your own machine. Nothing outside your laptop can reach it until you choose to expose it.

```bash
myco server status --target local     # address, whether it is running, where its data lives
myco server run --target local        # run it in this terminal instead, to watch it work
```

Its data sits in `~/.myco/server/local/`. Its output goes to `~/.myco/logs/server.log`.

Pick a different port with `--port` if 8787 is taken. To stop it starting at login, run `myco server uninstall --target local`; your data is kept. `myco server destroy --target local --data --yes` removes the server and everything in it.

> **Adding people, including yourself**
> Invites and sign-in arrive with the join work in #1158. Until then a server created this way has no members yet, so treat this page as the way to get one running rather than the way to start capturing.

## On a virtual machine

Anywhere that runs a Linux binary works. A machine with 1 GB of memory and a few gigabytes of disk is enough for a small team.

Copy the binary across, then run the same two commands. The server starts at boot through your user's own service manager, so nothing runs as root.

**Fly.io** is the least work if you would rather not manage a machine. Its builds happen remotely, so you never need a container runtime on your own computer, and a machine with a small volume attached costs a few dollars a month. Give the volume to `~/.myco/server/local/` and the server keeps its data across restarts.

**A plain VPS** works the same way. A basic droplet or equivalent is about the same price. Copy the binary, run the two commands, and put a reverse proxy in front of it for HTTPS.

When something else terminates HTTPS in front of your server, tell the server which header carries the caller's real address by setting `sourceFrom` and `trustedHeader` in `~/.myco/server/local/server.json`. The server refuses to start rather than trusting an address a caller could have written itself.

## Reaching it from cloud agents

Agents that run on your own machine reach your server directly. Agents that run in someone else's cloud — Claude Code on the web, Codex cloud, a code review agent on a pull request — cannot see `127.0.0.1`, so your server needs a public address before they can read your context.

Two ways to give it one without moving it:

**Tailscale Funnel** gives your machine a stable `https://…ts.net` name on any plan. You will need MagicDNS and HTTPS certificates turned on for your network, and the machine needs permission to use Funnel. It listens on 443, 8443 or 10000 only.

**Cloudflare Tunnel** connects your machine to a hostname you control. The quick version that needs no account is meant for testing and does not support the streaming transport MCP uses, so use a named tunnel with your own domain for anything you rely on.

Either way your server stays where it is and keeps its data locally. Only the address changes.

## Keeping it current

`myco update` replaces the binary. Then bring the server's storage up to date and restart it:

```bash
myco server update --target local
```

Running an older server against newer storage is refused rather than half-applied, so an interrupted update leaves your data intact.

## Backing it up

Everything the server holds is in one directory. Stop it, copy `~/.myco/server/local/`, and start it again. Restoring is the same in reverse.
