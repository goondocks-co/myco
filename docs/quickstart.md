# Quickstart

Myco keeps a team's coding-agent sessions, and the knowledge it draws from them, on a **Deployment**: a server your team shares. Each person's machine signs in to it, and their agents capture there and read from it.

There are two roles here. The **owner** sets up the Deployment once. Every **member**, the owner included, then connects a machine.

## Set up a Deployment (owner)

Choose where it runs:

- **On your laptop, or a small virtual machine.** Everything runs from the `myco` binary; there is no container and no Node.js.
- **On Cloudflare.** There is no machine to keep running. It needs Node.js and Cloudflare's `wrangler` tool on your own computer.

First install the binary (the next section shows how). Then, for a laptop:

```bash
myco server create --target local
myco server github-app --target local --url http://127.0.0.1:8787 --name "Myco sign-in"
myco server setup-owner --target local
myco server install --target local
```

1. `create` prepares the Deployment and its storage keys.
2. `github-app` registers a GitHub sign-in app under your account; confirm it on GitHub and come back.
3. `setup-owner` creates the first administrator and prints a private link, valid for 15 minutes.
4. `install` starts the Deployment and keeps it running whenever you log in.

Open the private link and sign in with GitHub to make your account the administrator. Keep the link to yourself: whoever uses it becomes the administrator.

[Self-hosting](self-hosting.md) covers the virtual machine and Cloudflare, updates, backups, and reaching the Deployment from cloud agents. The Cloudflare route has no command yet for its first administrator; see [Known gaps](#known-gaps).

### Invite people

Invitations are made on the dashboard's **Members** page. An invitation is a single link, valid for an hour unless you choose otherwise, that works once. Send it to the person joining.

To connect another machine of your own, make the invitation for your existing member rather than a new one: a machine belongs to one member.

## Connect a machine (member)

Install the binary:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh
```

It places `myco` in `~/.myco/bin` and changes nothing else. macOS and Linux are supported. On Windows, the PowerShell installer still installs Myco 1.4 and there is no 2.0 installer yet. If Myco 1.4 is on the machine, the installer stops and points you to [Upgrading from 1.4](upgrade-from-v1.md).

Sign in with the invitation, from the project you work in:

```bash
cd ~/code/your-project
myco login <invite link>
```

If the invitation names a project, this folder is connected to it, and your agents' earlier sessions here are brought in. If it does not, you are signed in, but no project is connected yet; see [Known gaps](#known-gaps).

On an administrator's machine, `myco login` also installs the worker that runs Myco's own work (see [How Myco learns](intelligence.md)).

Then give your agents their hooks and Myco tools, once per agent:

```bash
myco member provision claude-code
```

[Agents](agents.md) lists every agent Myco captures and the name to use for each.

## Check that it works

From the connected project:

```bash
myco doctor
```

Every row should pass. Start a session in your agent, then look for it on the dashboard's **Sessions** page for the project. If it does not appear, see [Troubleshooting](troubleshooting.md).

What Myco does with a session next depends on what the project has turned on. A new project captures and titles sessions. An administrator turns on spores, the repository map and context for agents in [Configuration](configuration.md).

## Known gaps

These are open, and the steps above describe Myco as it works today:

- **Connecting a project after signing in.** Invitations made on the dashboard name no project. A new member who signs in with one has no command to connect a project, because `myco member join` needs a token that no command hands out. `myco cutover` connects every project a 1.4 install knew. For everyone else, this is [#1499](https://github.com/goondocks-co/myco/issues/1499).
- **Agents after `myco login`.** Signing in gives your agents nothing; `myco member provision <agent>` does. [#1499](https://github.com/goondocks-co/myco/issues/1499) also covers skills reaching your agents and keeping their config current.
- **The first administrator on Cloudflare.** `myco server setup-owner` works only for a laptop or VM Deployment. On Cloudflare the first administrator comes from scripts in the source repository. See [#1500](https://github.com/goondocks-co/myco/issues/1500).
- **Member settings** such as a log level or update channel are shown but not honoured yet.
