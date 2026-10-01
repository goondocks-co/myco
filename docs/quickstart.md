# Quickstart

Myco keeps a team's coding-agent sessions, and the knowledge it learns from them, on a **server** your team shares. Myco's commands and messages call it a **Deployment**. Each person's machine signs in to it. Their agents capture there, and read back what the team knows.

There are two roles here. The **owner** sets up the server once. Every **member**, the owner included, then connects a machine.

## Set up a server (owner)

Choose where it runs:

- **On your laptop, or a small virtual machine.** Everything runs from the `myco` binary; there is no container and no Node.js.
- **On Cloudflare.** There is no machine to keep running. It needs Node.js and Cloudflare's `wrangler` tool on your own computer.

First install the binary, as shown under **Connect a machine** below.

On a laptop, run:

```bash
myco server create --target local
myco server github-app --target local --url http://127.0.0.1:8787 --name "Myco sign-in"
myco server setup-owner --target local
myco server install --target local
```

1. `create` prepares the server and its storage keys.
2. `github-app` registers a GitHub sign-in app under your account; confirm it on GitHub and come back.
3. `setup-owner` creates the first administrator and prints a private link, valid for 15 minutes.
4. `install` starts the server and keeps it running whenever you log in.

On Cloudflare, the same three steps set it up and put it online:

```bash
myco server create --target cloudflare --account-id <your account id>
myco server github-app --target cloudflare --url <the address create printed> --name "Myco sign-in"
myco server setup-owner --target cloudflare
```

Either way, open the private link `setup-owner` printed, sign in with GitHub and click **Connect this account**. Your account is now the administrator. Keep the link to yourself: whoever uses it becomes the administrator.

[Self-hosting](self-hosting.md) covers each route in full, along with virtual machines, updates, backups, and reaching the server from cloud agents.

### Connect your own machine

Your account can now open the dashboard, but no machine of yours has signed in yet. On **People & machines**, choose **Add a machine**, set **For** to yourself, and create the link. Then follow **Connect a machine** below with it.

If the server runs on this laptop, it is also the machine that does Myco's work. After `myco login`, restart the server so its worker starts:

```bash
myco server uninstall --target local
myco server install --target local
```

Both keep your data.

### Invite people

On **People & machines**, choose **Invite a teammate**. You get a one-time link, good for an hour or a day, and the exact `myco login` command to send. Once they have signed in, choose **Connect GitHub** on their row and send them that link too, so they can open the dashboard.

To connect another machine of someone already here, use **Add a machine** instead. A machine belongs to one member, so an invitation for a new member is refused on a machine that already joined.

> **Coming in beta.1:** inviting a teammate from the command line, so an owner can invite people before GitHub sign-in is set up ([#1551](https://github.com/goondocks-co/myco/issues/1551)).

## Connect a machine (member)

Install the binary:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh
```

It places `myco` in `~/.myco/bin` and changes nothing else. If Myco 1.4 is on the machine, the installer stops and points you to [Upgrading from 1.4](upgrade-from-v1.md).

> **Coming in beta.1:** Myco 2.0 on Windows ([#1550](https://github.com/goondocks-co/myco/issues/1550)). Until then, macOS and Linux are supported, and the PowerShell installer installs Myco 1.4.

Sign in with the link you were sent:

```bash
myco login <invite link>
```

This signs the machine in and sets up every coding agent installed on it to capture; [Agents](agents.md) lists the ones Myco captures. An agent whose settings belong to another Myco installation is left as it is, and named. On an administrator's machine, `myco login` also starts the worker that runs Myco's own work (see [How Myco learns](intelligence.md)). The laptop that runs the server is the exception: restart the server instead, as shown above.

Start a new session in each of your agents afterwards; an agent that was already open picks up its hooks and Myco tools at its next start.

Then connect each repository you work in:

```bash
cd ~/code/your-project
myco member join
```

It lists the server's projects and asks which one this repository is. To create a project instead, named for the folder, run `myco member join --new`. Your agents capture there from then on, and their earlier sessions in that folder are brought in.

> **Coming in beta.1:** repositories under `~/Repos` will connect on their own the first time an agent works in them, so `myco member join` is only needed for repositories elsewhere ([#1547](https://github.com/goondocks-co/myco/issues/1547)).

## Check that it works

From a connected repository:

```bash
myco doctor
```

Every row should pass. Start a session in your agent, then open the dashboard:

```bash
myco open
```

The session appears on **Today** and on **Sessions**. If it does not appear, see [Troubleshooting](troubleshooting.md).

What Myco does with a session next depends on the project. Every project captures, and Myco titles and summarizes its sessions once a worker is running. For Myco to learn spores from them, an administrator turns on two things: **Learning** in the project's **Project settings**, and **Work on a schedule** under **Settings** → **Myco's work**, which is off on a new server. The code map and context for sessions are switched on in **Project settings** too. See [Configuration](configuration.md) and [The dashboard](dashboard.md).

To stop capturing a repository, run `myco member leave` in it.

## Keeping Myco current

Run the installer again. It replaces the binary, and on a machine that is already signed in it refreshes your agents' Myco setup to match.

## Removing Myco

To take Myco off a machine, run:

```bash
myco remove
```

It takes Myco's hooks and tools out of every agent's settings, leaving the rest of each file as it was. It also removes this machine's worker service. It asks before it starts; `--yes` skips the question. What the machine captured stays on the server, and `~/.myco` stays on the machine unless you add `--purge`, which deletes it, the `myco` binary included. To stop one repository capturing instead, run `myco member leave` in it.
