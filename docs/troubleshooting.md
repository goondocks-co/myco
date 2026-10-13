# Troubleshooting

Start with these commands. Run the last one from the repository whose capture you are checking:

```bash
myco doctor
myco setup --status
myco member status
```

Doctor checks this machine's memberships, server reachability, agent setup, delivery and runner records. From a connected repository it also checks authenticated project access. A local credential that has not expired is not proof the server still accepts it. Rows marked **not-checked** say what remains unverified.

Setup status reports observed progress without changing it or contacting the server. It is useful after an interrupted setup. Neither status command repairs an installation; follow the action named by each row.

## Read the status rows

| Doctor row | What to check |
|---|---|
| Membership / Memberships / Credential | The address, member sign-in and whether the credential can renew. Sign in again if it has ended. |
| Default Myco | Which server new repositories join. If none is selected, choose with `myco login <address> --default`; this approves the machine again. |
| Deployment / Project access | Whether the server answers, and whether this repository's credential reaches its tools. |
| Repository / Repositories | Where each connected folder sends its sessions, or why it is left unconnected. |
| Setup / Capture | Whether agent hooks, skills and tool entries are current, and whether capture actually ran. |
| Capture backlog / Refusals | Queued delivery, a delivery hold-off or events the server refused. |
| Runner / Runner service / Runner offer | Registration, service state and which agents the runner last offered. |
| Migration / Myco 1.4 | Whether old history and capture have handed over. Follow [Moving from Myco 1.4](upgrade.md#upgrading-from-myco-14). |

In setup status, **Signed in** and **Sign-in credential** describe local records, **Agent hooks** describes provisioning, and **Repository** describes routing. **Deployment** and **GitHub sign-in** report setup observations, not a fresh network check. **Runner**, **Runner service** and **Runner agents** describe the separate runner journey. **Capture** groups backlogs, hold-offs and refusals. Resume incomplete setup with `myco setup --join <address>`, or the runner journey with `myco setup --runner <address>`.

## Installing

If the installer says it found no Myco 2.x release, it installed nothing. Check the [releases page](https://github.com/goondocks-co/myco/releases). If it finds Myco 1.4 and stops, follow [Moving from Myco 1.4](upgrade.md#upgrading-from-myco-14) rather than replacing it before planning the move.

The Windows x64 installer selects 2.x releases too, but the 2.0 Windows path remains unverified. See [Join a Myco](quickstart.md) for the supported installation path.

## Signing in

### The invitation is refused or the machine's sign-in ended

An invitation works once. `enrollment_used`, `enrollment_expired` and `enrollment_revoked` mean you need a fresh one; `enrollment_unknown` can also mean an incomplete link. For an unreachable server, restore connectivity or correct its address first.

Ask an administrator to use **People & machines › Add a machine**, with **For** set to your existing member, then run the login command it shows. If you already sign in to the dashboard, you can instead run `myco login <address>` and approve the machine in your browser.

If you see `identity_claimed`, this machine already belongs to a member of that server. Ask for a link for that existing member. Removing a member does not transfer their machines to someone else.

### Signed in to the wrong Myco

Check the addresses in Doctor and the repository routes in member status. To leave one server:

```bash
myco logout <address>
```

This revokes this machine's member credential and removes its local connections to that server. Captured history stays on the server. Other memberships and runner registrations remain.

If the server is unreachable, `myco logout <address> --local-only` removes local connections without revoking the remote credential. Ask an administrator to stop that machine's access in the dashboard. Then sign in to the intended server and reconnect the repository.

On a machine joined to two servers, an agent's Myco tools may reach only one of them. Check Doctor before relying on both ([#1724](https://github.com/goondocks-co/myco/issues/1724)).

## Capturing

### A repository is not captured

Only Git repositories capture. Repositories under **My machines › Its settings › Folders it captures** join the default Myco when an agent works in them. The default parent folder is `~/Repos`.

For a repository elsewhere, run `myco member join` inside it. If no project holds its remote and **Create a project for it** is off, an administrator must connect it. Doctor and member status show repositories still joining or left unconnected.

### An agent captures nothing

If Doctor reports missing or stale agent setup, repair the entries with:

```bash
myco member provision --refresh
```

To set up just one agent, use `myco member provision claude-code`, substituting the agent you use. Start a **new** agent session afterward. See [Agents](agents.md) for the six capture agents and their configuration locations. Plugin-only access has tools and skills, but no capture hooks.

### Sessions are waiting to be delivered

Capture waits on the machine when the server is offline. Member status shows queued events and acknowledgements. After restoring connectivity, send the queue now:

```bash
myco member drain
```

Use `myco member drain --all` for every connected repository on the machine. If events are refused, read `myco logs` and resolve the named refusal. Repeating a terminal refusal unchanged will not fix it.

For a bug report, `myco member export` emits delivery and connection diagnostics without tokens or captured content. Review the output before sharing it.

## Nothing is being learned

Captured sessions and agent work are separate. Check these in order:

1. **Runners:** an administrator has explicitly registered and approved a runner, it is running, and it offers a signed-in agent. Member login and server startup do not start a runner.
2. **Settings › Myco’s work › Work on a schedule:** turn it on for automatic learning. It starts off. You can also use **Myco’s work › Run a task** manually.
3. **Project settings › What Myco does here:** **Learning** must be on for learning and **Code map** for maps. All three project switches start on, but an administrator may have opted out.
4. **Project settings › Repository:** connect the repository for code maps or learning from code. Automatic maps also need **Update the map on its own**.

Open the run under **Myco’s work** for its result or reason for waiting. Large initial histories ramp at two automatic learning runs a day; runs of one task default to two at once across projects. A task can read material and find nothing new worth keeping. See [How Myco learns](how-myco-learns.md).

If a manual start reaches the member's daily limit, the dashboard says when it can be started again. The default is four starts of each task per member in a rolling day across projects. An administrator can change that allowance in [Configuration](configuration.md#starting-work-by-hand).

## Checking a runner

On the machine registered to run work:

```bash
myco runner status --server <address>
myco runner doctor --server <address>
```

Check registration, recent contact and the agents offered or withheld. A running process alone does not prove an agent can take a task. The runner uses agents already signed in on that machine. For registration and operation, see [Runners](runners.md).

## Cloudflare returns 403

If login, capture or tool calls receive an HTML challenge instead of a Myco response, ask the server's operator to check Cloudflare security events. A WAF or bot challenge can reject non-browser clients before Myco sees the request. Follow the WAF guidance in [Run your own Myco](self-hosting.md#custom-domain-requests-blocked-before-myco), then check Doctor again. Reinstalling capture hooks does not resolve a challenge at the server's front door.

## Removing Myco

Leave each Myco while it is reachable, so the machine's member credentials are revoked:

```bash
myco logout <address>
```

If this machine also runs work, remove its runner service separately:

```bash
myco runner uninstall --server <address>
```

This retains the runner's registration. An administrator can stop its access on **Runners**. If this machine hosts a local server as a service, stop that service separately before removing the install:

```bash
myco server uninstall --target local
```

Stopping the service keeps its data. Coordinate with the people who use that server before stopping it. A foreground server is stopped in its terminal.

Then remove Myco's global agent entries, skills and service wiring:

```bash
myco remove
```

The command asks for confirmation and keeps captured data by default.

`myco remove` unregisters this home's member integrations and worker/runner services while preserving data. `--purge` deletes only the named 2.0 entries: `member/`, `skills/`, `bin/`, `install.json`, `runtime.command`, `runtime.home`, `logs/`, `runner/`, `worker/` and `installer-audit/`. It preserves 1.4 files, their cutover receipt, `backups/cutover-*` and unknown entries, prints what remains, and removes the home directory only when empty. The confirmation lists each deletion. Purge refuses the user home, its ancestors, filesystem roots, the current directory and symlinked homes.

A home holding `server/` or a Cloudflare operator record refuses purge unless you also pass `--allow-deployment-loss`. Back up the Deployment first; the override admits deletion of `server/`, including its data and operator records. An installed native Deployment service blocks purge even with the override: run `myco server uninstall --target local` first. Check retained 1.4 backups before deleting legacy files by hand.
