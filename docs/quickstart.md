# Join a Myco

Connect your machine to a Myco, start a coding session, and see the work on Today. You need a supported coding agent and an invitation from an administrator. If you already sign in to the dashboard, you can use its address instead. To run your own instead, follow [Run your own Myco](self-hosting.md). Moving existing data? See [Moving from Myco 1.4](upgrade.md#upgrading-from-myco-14).

## 1. Install

On macOS or Linux:

```bash
curl -fsSL https://myco.sh/install.sh | sh
```

Myco is a native binary; no Node runtime is needed. On Windows x64:

```powershell
irm https://myco.sh/install.ps1 | iex
```

The 2.0 Windows path is not yet verified. The installers download an available 2.x GitHub release. Existing 1.4 installations require [explicit replacement and cutover](upgrade.md#upgrading-from-myco-14).

## 2. Sign this machine in

### If you are new to the team

Ask an administrator to open **People & machines**, choose **Invite a teammate**, and send you the one-time login command it shows. Run that command on this machine. An invitation expires and works once; ask for a fresh one if it is refused.

After you join, ask an administrator to choose **Connect GitHub** for your entry on **People & machines** and send you the connection link. Open it in a browser and connect your GitHub account for dashboard access. Then open the dashboard at your Myco's address.

### If you already sign in to the dashboard

Run this from the repository you want to connect:

```bash
myco setup --join <address>
```

Setup guides sign-in, project selection and agent setup. You can run `myco setup` again to resume; it uses this machine’s existing connections and asks which Myco to continue with if needed. Joining does not require you to run Myco's own tasks; decline the runner choice if this machine is only for your coding sessions.

If you only need sign-in and agent setup, use:

```bash
myco login <address>
```

A bare address such as `myco.example.com` uses HTTPS. Use the full address, including `http://` and the port, for a local server.

The terminal prints a URL and a code. Open that URL in a browser already signed in to the Myco dashboard. Check the code and machine details, then choose **Approve this machine**. The terminal waits for approval, so this works over SSH too.

## 3. Let repositories join

Myco sets up the installed capture agents in their **global** configuration: Claude Code, Codex, Cursor, OpenCode, Pi and Cline. Start a new agent session after setup. See [Agents](agents.md) for locations and controls.

Git repositories under `~/Repos` join the default Myco the first time an agent works in them. A repository joins the project that already holds its Git remote, or creates a project when none does. Change **Folders it captures** under **My machines** to use other parent folders.

For a repository elsewhere, run this inside it:

```bash
myco member join
```

Choose an existing project or create one when asked. To choose directly, use `myco member join --project <id-or-name>` or `myco member join --new [name]`. Only Git repositories capture. `myco member status` shows connected repositories and those that are still joining or could not join.

## 4. See the session on Today

Start a **new** session in your coding agent and do some work. Open the dashboard at your Myco's address and select the project on **Today**. The session should appear there; **Sessions** lets you open it later. **Knowledge** holds the project's spores, plans and code map.

Capture and learning are separate. Myco's own agent needs a registered runner with a signed-in coding agent before it can learn from sessions. An administrator registers one using the [runner guide](runners.md). For automatic learning, they also turn on **Work on a schedule** in **Settings**. They can run work manually with **Run a task** under **Myco’s work**.

The project switches **Context for sessions**, **Code map** and **Learning** are on by default. A code map and learning from code also need a connected repository. You can see what ran under **Myco’s work**.

## 5. Check the connection

```bash
myco doctor
myco setup --status
myco member status
```

Doctor checks membership, capture, queued delivery, tools, runner state and server reachability. Setup status reports observed progress without changing it. Neither is a replacement for browser approval.

If the server is offline, capture waits on this machine and is delivered when it answers again. To deliver queued capture now, run `myco member drain` from the repository.

If a session does not appear, check that the repository joined, that your agent started a new session after setup, and that the server is reachable. If sessions arrive but no spores appear, ask an administrator to check the runner, schedule and project switches.

## Plugin only

Install Myco from your agent's plugin marketplace, then provide your Myco's address and a project access key when asked. The plugin can read project knowledge and record findings. It carries tools and skills, but no binary or capture hooks. See [External agents](external-agents.md#use-the-plugin). Install the binary and join when you want this machine's sessions captured too.

## Leaving a Myco

```bash
myco logout <address>
```

This revokes this machine's member credential for that Myco and removes its local connections. Captured data is kept. Other Mycos and runner registrations remain in place. Agent configuration is updated separately for each agent. If logout reports that it could not finish updating an agent, fix the named file problem and rerun the same logout command, even if the local connection has already been removed. If the server is unreachable, `myco logout <address> --local-only` removes the local connection without revoking the server credential; an administrator can stop it in the dashboard.

**Known limit:** on a machine joined to two Deployments, an agent's Myco tools may reach only one of them. Check `myco doctor` before relying on tools across both ([#1724](https://github.com/goondocks-co/myco/issues/1724)).
