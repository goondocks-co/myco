# Updating Myco

Coding machines, runners and the Deployment have separate update steps. Updating a coding machine does not update the server it connects to.

## Update this machine

```bash
myco update --check
myco update
myco doctor
```

Myco 2.0 updates on demand on member machines. A member installation runs no member update timer or local service. `--check` reports availability without replacing the binary or changing agent setup. `myco update` verifies the download, replaces the installed binary and refreshes global agent configuration, even when the binary is already current. Read its result for any remaining step, then start a new coding-agent session. Doctor checks the connection and setup and reports cached update information.

The installer records a release channel. **Stable** selects stable releases; **beta** includes beta and stable; **alpha** includes alpha, beta and stable. Updates choose the newest eligible version and keep your current build when the available one is older. A fresh installer chooses an available 2.x stable release, then beta, then alpha when no later release phase exists.

To use another channel for one update:

```bash
myco update --channel beta
```

This does not change the recorded channel. An explicit channel on a repeat install does.

## Update runners

Installed runners check for releases and update themselves **between runs**, within their recorded channel. In **Runners**, an owner or administrator can choose **Update now** when a connected runner reports an available update. A busy runner finishes its run first. The page shows its version, channel and last update result.

On the runner machine, `myco update` also queues the service's update between runs. For checks and recovery details, see [Runner updates](runners.md#updates-between-runs). On a machine that both captures and runs tasks, an update handoff can leave agent refresh pending; finish with an interactive `myco update` or `myco member provision --refresh` after the handoff.

## Update a Deployment

On the machine that manages it, update the binary, then run the command for its target:

```bash
myco update
myco server update --target local
myco server status --target local
```

For Cloudflare:

```bash
myco update
myco server update --target cloudflare
myco server status --target cloudflare
```

Take a verified full backup before a local storage-format change. Cloudflare saves a D1 Time Travel bookmark before advancing an existing database's schema; a Worker rollback alone leaves that database unchanged. Follow [Update and recover an update](self-hosting.md#update-and-recover-an-update) for bookmarks, rollback and full recovery. After updating, check dashboard sign-in, new capture and runner contact.

<a id="upgrading-from-myco-14"></a>

## Moving from Myco 1.4

Myco 1.4 retains its local service and background updater. Moving to 2.0 hands capture to member hooks; Myco's own work needs a registered runner.

Keep a backup of the 1.4 home. Installing 2.0 replaces the binary immediately; old hooks stop capturing until sign-in and cutover finish. The installer preserves a recognized 1.4 installation unless you explicitly pass `--replace-1.4`. It keeps and refuses an unrecognized binary rather than guessing.

Preview the replacement, then install and start guided setup:

```bash
curl -fsSL https://myco.sh/install.sh | sh -s -- --dry-run --replace-1.4
curl -fsSL https://myco.sh/install.sh | sh -s -- --replace-1.4
myco setup
```

To choose a release phase explicitly, set `MYCO_CHANNEL=beta` or `MYCO_CHANNEL=alpha` on `sh`. On Windows x64, use the PowerShell installer's `-Replace14` option; the 2.0 Windows path is not yet verified.

Setup detects 1.4 data and registrations by reading files; it never executes a 1.x binary. It helps you sign in to an existing Deployment or create one, previews the cutover, asks you to approve that exact plan and runs the existing cutover operation. Each project has its own destination, so one move can cover several Deployments. Sign in to every destination first. Projects with no route require an explicit destination or skip choice.

For an existing Deployment:

```bash
myco setup --join <address> --cutover
myco setup --join <address> --cutover --route <project-id>=<other-address> --skip <other-project-id> --yes --no-runner
myco setup --status
```

Run `myco setup` again to resume. `--yes` accepts a printed first plan; a changed vault digest, destination, skip choice or capture agent set requires fresh interactive approval. `--no-agents` declines installing 2.0 agent integrations during the handover. `--no-cutover` leaves the migration pending. Status is strictly read-only. If 1.4 wrote more data after migration, keep its files, stop 1.4 and review the new plan. Setup names partial imports and remaining handover work, then resumes them through cutover's receipts and import ledger.

### Manual cutover

For direct control over the move, choose or [create a Deployment](self-hosting.md), then run:

```bash
myco login <address>
myco cutover --dry-run
```

The cutover preview names the old homes, projects, destination for each project, agent settings changes, service handover and copies it would make. Review all of them. Cutover uses a repository's existing connection or a saved destination receipt first. An existing Git repository without a connection or saved route goes to the default Deployment, labelled `(default Deployment; no repository route)` in the plan. Only absent or rootless repositories with no route are refused, unless you give `--route`, `--skip` or `--server`. Sign in to each destination before continuing.

### Resolve destinations and old folders

Use the project ids printed by the preview:

| Option | Use it for |
|---|---|
| `--route <id>=<url>` | Sending one 1.4 project's history to a signed-in Deployment, including a project whose repository no longer exists |
| `--skip <id>` | Leaving one project's history and spool in place for now |
| `--server <url>` | Choosing a fallback for projects without a repository connection; existing connections still determine their destinations |
| `--map <old-dir>=<repo-root>` | Attributing agent transcripts from an old or deleted worktree directory to the project connected at the current repository root |
| `--legacy-home <dir>` | Including another 1.4 home |

Guided setup accepts repeated `--route` and `--skip` choices. Use manual cutover for `--server`, `--map` and `--legacy-home`. These manual options can be repeated for multiple projects, folders or homes, except `--server`, which names one fallback. Quote a mapping containing a trailing `*` to match sibling transcript directories. `--map` attributes transcripts; it does not choose a vault project's Deployment. A project without a usable repository needs `--route` or `--skip`, or an explicit `--server` fallback. A route that conflicts with an existing repository connection is refused; review the connection first.

For example, preview an explicit route and skip before applying them:

```bash
myco cutover --dry-run --route <project-id>=<address> --skip <other-project-id> --map '<old-dir>=<repo-root>'
myco cutover --route <project-id>=<address> --skip <other-project-id> --map '<old-dir>=<repo-root>'
```

For a preview that needs no extra options, apply it with:

```bash
myco cutover
```

### What moves, and how to check it

Cutover backs up changed agent settings, connects the old project folders, hands agent configuration to 2.0 and stops the 1.4 service. It then copies and verifies each old vault before importing project history and agent transcripts. The original vaults stay in place. Copies and imports can resume when you rerun the command.

Receipts in `~/.myco/member/cutover.json` record destinations, verified copies, history import and transcript progress separately. A partial or refused import is unfinished, even if agent setup succeeded. Fix the named problem, preview again and rerun with the same routing choices. If a repository now points elsewhere than its receipt, confirm the new destination with `--route` or leave it with `--skip`.

Old extra plan folders are reported, not silently copied into machine settings. Add the ones you still want under **My machines** → **Extra plan folders**. Configure the Deployment's models and schedule in **Settings** and register a [runner](runners.md); moving history does not enroll a runner.

Run `myco doctor` and `myco member status`. In the dashboard, check each destination's projects, sessions, spores and plans, then start a new coding session and confirm it appears on **Today**. Keep 1.4 data and the cutover copies until you have verified both history and new capture.

Start a new coding-agent session after moving; an already-open session keeps its earlier Myco connection. For maintaining an installation that stays on 1.4, use the [1.4 documentation](https://github.com/goondocks-co/myco/tree/release/1.4/docs).
