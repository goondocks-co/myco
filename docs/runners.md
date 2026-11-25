# Runners: where Myco's work runs

A runner is a machine you choose to lend a signed-in coding agent to Myco. The Deployment stores sessions and queues work; registered runners claim that work and carry it out. A coding machine can capture sessions without being a runner. Running a Deployment does not enroll its host either.

Use a machine that can reach the Deployment and stay available long enough to finish tasks. For a loopback Deployment, use the same machine. For Cloudflare, a runner can be elsewhere. Agent sign-ins use the runner machine by default; its registration is separate from a member's sign-in and does not enable capture.

## 1. Sign in to a coding agent on the runner

Install a supported coding agent, such as Claude Code, Codex or OpenCode, and complete that agent's normal sign-in **on the runner machine**, under the account that will run the service. A login on your laptop does not sign in another machine. Check that the agent can actually run work with your subscription or provider access.

In **Settings** → **Models**, choose the agent and who pays for it; under **Advanced**, set the model for each job size. Codex and OpenCode need a model for each size that tasks use. The **Legacy workers sign in with** field applies only to legacy workers. Registered runners use their per-agent choices on **Runners** instead.

In **Settings** → **Myco’s work**, **Preferred agent** and **Then try, in order** choose among the agents the runner offers. A listed model alone does not prove access or available quota.

## 2. Register and start it

Install the Myco binary using the [installation steps](quickstart.md#1.-install), then run:

```bash
myco runner register <address> --name <runner-name>
```

Use the full `http://127.0.0.1:8787` address for a local Deployment. A bare hostname uses HTTPS. Registration prints a device approval link and code and waits; it works over SSH without a browser on the runner. Open the link in a browser signed in to the dashboard as an owner or administrator. Check the code, runner name and machine, then approve.

Start the enrolled runner's per-user service:

```bash
myco runner install --server <address>
myco runner status --server <address>
myco runner doctor --server <address>
```

The service starts at login and uses this account's agent sign-ins. Status shows registration, service, contact and offered agents; doctor diagnoses what prevents it from running. To run in a terminal instead, use `myco runner run --server <address>` and stop it with Ctrl-C. One runner serves a given Deployment per machine; a second executor waits for the first to stop.

## 3. Check its machine page

Open **Myco's work › Runners** in the dashboard. Each runner is one row with what it is doing or last did; **Its machine** opens the machine's page, which shows whether it is working, which agent it uses and who pays, its runs in the last 24 hours, the version and release channel it reported and update results. Open **Details** there for agent sign-in reports and model information. If it is not ready, check its reported reason and run doctor on that machine.

Each runner has its own card on its machine page. An owner or administrator turns its **runs Myco’s work** switch off to let its current task finish while it takes no new work, and on again to resume. **Remove … as a runner** revokes that runner’s authority immediately and preserves capture and any other runner on the machine. A running runner stops when it hears it was removed. Unfinished work can retry on another runner after its assignment expires.

On the runner machine, run `myco runner status --server <address>` to check its registration. Run `myco runner uninstall --server <address>` to stop and remove its service and clear the local registration and credential once the server confirms removal. While the runner is still registered, uninstall removes only the service. To enroll the machine again after clearing the old registration, run `myco runner register <address>` and have an owner or administrator approve its code.

## Use a stored API key

For a machine without a subscription, install the agent and register the runner. In **Settings** → **Connections**, add the provider key, then in **Settings** → **Models** set **Paid by** to **A stored key** (or, on one runner's machine page, choose **Set this machine apart** and **Use the server’s stored key**). Claude Code and OpenCode use the Anthropic slot; Codex uses its own Codex (OpenAI) slot. Cursor uses the Cursor slot with a Cursor API key, as [Cursor’s CLI authentication documentation](https://cursor.com/docs/cli/reference/authentication) specifies. An Anthropic key cannot sign the Cursor CLI in.

You can also request choices during registration:

```bash
myco runner register <address> --name <runner-name> --sign-in claude-code=stored,opencode=own
```

The device approval page names these choices. An administrator must approve them. The `stored` choice requires a usable key. Omitted agents use the machine on a new runner; replacement registration also resets omitted agents to this machine’s sign-in. Request each stored key again so it appears in the new approval.

Each agent defaults to **this machine’s sign-in**, including on existing runners. A subscription runner is never moved onto API billing by adding or changing a stored key. Only an explicit choice for that runner and agent enables the stored key. Changing one agent does not change another.

The stored choice is unavailable when there is no usable key. If a chosen key is later removed, unreadable or of a kind that the agent cannot use, work waits for that credential; it never falls back to the machine’s sign-in. Claude Code accepts an Anthropic API key or subscription token; OpenCode and Cursor accept API keys only. Choose **Use this machine’s sign-in** to return deliberately to the machine’s account. Sign-in status still reports the machine’s own login, even when work uses a stored key.

Choose **A stored key first, then the runner’s own sign-in** on Models or a runner's machine page, or request `--sign-in <agent>=stored-first` at registration. With this choice the runner uses its own sign-in while the key is missing, out of credit or rejected. A failed key attempt queues the work again for a runner’s own sign-in. At most one ordinary run rechecks a held key each hour, when work and budget are available. Work returns to that key after a successful recheck. Models, Connections, the runner's machine page and Health show the key’s state, and each run records the sign-in it used.

Legacy workers default to their machine’s sign-in. An explicitly saved **Legacy workers sign in with** choice can retain their supported server-key flow; it never changes a registered runner.

## Let Myco work

The project switches **Context for sessions**, **Code map** and **Learning** are on by default. A connected repository is also needed for code maps and learning from code. These switches do not turn on the Deployment's schedule: in **Settings** → **Myco’s work**, enable **Work on its own** for automatic work. Use **Run a task** under **Myco’s work** for a manual start, and check its result there.

By default, **two runs of the same task can run at once across all projects**. Change **Runs of one task at once** under **Settings** → **Myco’s work** → **How much at once**. Work past a concurrency limit queues until capacity is available. Adding runners does not override the limit. Daily task ceilings are separate: reaching one holds off another start until a later scheduling check.

### The first-extraction ramp

A large first import is learned gradually. When initial eligible history exceeds one extraction batch, automatic learning starts with a limit of **two runs per day per project**. The ramp ends when that initial history is processed or its active window expires (14 days by default). Later sessions do not extend the initial-history window. This daily ramp is separate from the two-at-once concurrency default.

Check **Myco’s work** to see completed runs and why further work is waiting. Sessions can already be visible while learning is still catching up. Small histories and projects that have already processed prompts do not need the ramp.

## Updates between runs

Installed runner services check for eligible releases every six to ten hours and update between runs. On **Runners**, choose **Update now** when an update is available; a busy runner finishes its run before applying it. The page reports checks, availability, health verification and the last result.

On the runner machine:

```bash
myco runner update --check --server <address>
myco runner update --server <address>
```

The updater verifies the release before replacement and checks authenticated contact after restart. A failed handoff restores the previous binary. A failed release can be blocked temporarily; the page shows the reason and expiry. **Clear block and update** or `myco runner update --server <address>` requests a retry. A foreground runner using another executable refuses service updates.

Members update on demand with `myco update`. If the same machine also captures sessions and its runner handoff leaves agent refresh pending, run interactive `myco update` or `myco member provision --refresh` afterward. See [Updating Myco](upgrade.md).

## Retire a legacy worker

An older standalone worker service stays until you explicitly retire it. On its machine, run `myco worker status`, let assigned work finish, and use the retirement command it prints. Then register and install the runner. Retiring the legacy worker preserves membership and capture; it does not move its agent sign-in to another machine.
