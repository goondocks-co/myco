# Myco

Your agents learn from the work you have already done. Myco captures coding sessions; its own agent turns them into durable knowledge, alongside your agents' plans. Project instructions return at session start, and relevant spores and plans return with each prompt.

Capture works with Claude Code, Codex, Cursor, OpenCode, Pi and Cline. One server holds your projects, member machines send it sessions, and separately registered runners provide the signed-in agents that do Myco's own work.

## Install and join

Use the native installer for Myco 2.0 on macOS or Linux:

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Windows x64 has an installer; the 2.0 Windows path is not yet verified:

```powershell
irm https://myco.sh/install.ps1 | iex
```

No Node runtime is needed. The installers select an available 2.x release. An unqualified npm install may still select the 1.4 release line.

New to the team? Run the one-time login command your administrator sends from **People & machines › Invite a teammate**. After you join, ask them to use **Connect GitHub** and send you the link to connect your account for dashboard access.

If you already sign in to the dashboard, you can use the Myco's address instead:

```bash
myco setup --join <address>
```

Approve this machine in a browser signed in to your Myco. Start a new coding session in a repository under `~/Repos`, and see it on **Today**. Setup writes each installed agent's global configuration.

Learning runs on a runner your administrator sets up.

- [Join a Myco](https://myco.sh/quickstart)
- [Run your own Myco](https://myco.sh/self-hosting)
- [Move from Myco 1.4](https://myco.sh/upgrade#upgrading-from-myco-14)
- [Agents](https://myco.sh/agents)
- [Agent tools and skills](https://myco.sh/agent-tools)
- [External agents and plugin-only use](https://myco.sh/external-agents)

## License

Apache-2.0. Copyright Goondocks Consulting LLC.
