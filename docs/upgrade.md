# Updating Myco

Coding machines, runners and the Deployment have separate update steps. Updating a coding machine does not update the server it connects to.

## Update this machine

```bash
myco update --check
myco update
myco doctor
```

Myco keeps itself current about once a day in the default home, when a coding session starts a helper with enough time to check. Skipped checks and failed attempts wait until the next day too. Run `myco member status` or `myco doctor` to see when it last checked and what happened.

Automatic member updates are on by default. To turn them off or back on:

```bash
myco update --automatic off
myco update --automatic on
```

These commands save the choice for this installation without running an update. Turning updates on checks for an update at the next coding session with enough time. When off, `myco member status` and `myco doctor` show that choice; the helper records a skipped check about once a day without contacting the release service. Manual updates still work. A missing or unreadable setting means on; doctor reports an unreadable setting.

A member installation runs no member update timer or local service. Automatic replacement also skips a non-default `MYCO_HOME`, a runtime pin selecting another binary, or a development build. `--skip-binary` applies only to the manual command.

`--check` reports availability without replacing the binary or changing agent setup. `myco update` verifies the download, replaces the installed binary and refreshes global agent configuration, even when the binary is already current. Read its result for any remaining step, then start a new coding-agent session. Doctor checks the connection and setup and reports cached update information.

Binary updates support macOS, Linux and Windows. Myco checks the downloaded version before and after replacement and keeps the previous binary beside the installed one. If the replacement fails its check, the result says **update rolled back** and names the restored version. A version that failed verification is skipped on later automatic or channel updates; `myco update <version>` retries it explicitly and clears the failure after success. If an earlier version cannot be removed, the result names the retained file and why it was kept.

On Windows, if `myco.exe` is missing after an interrupted update, run `move "<bin-dir>\myco.prev.exe" "<bin-dir>\myco.exe"` or rerun the installer.

A development build or a runtime pin selecting another binary reports **binary update skipped**, with its reason. `myco update --skip-binary` explicitly keeps the binary and still refreshes agent setup. Automatic updates also skip non-default Myco homes; a person can update an installation using `MYCO_HOME` or `MYCO_BIN_DIR` as usual. If another update is running, Myco says so.

Agent setup runs after the binary step, including a skipped update or rollback. When another Myco home manages this machine's agent configuration, its global hooks, MCP entries and skill links are preserved. To explicitly transfer responsibility to this home, run `myco update --claim`. `--check` never takes responsibility or refreshes agents.

The installer records a release channel. **Stable** selects stable releases; **beta** includes beta and stable; **alpha** includes alpha, beta and stable. Channel updates choose the newest eligible version and keep your current build when the available one is older. An explicit `myco update <version>` can step back to an older eligible version. To stay there, run `myco update --automatic off`; otherwise automatic updates will move this machine forward again. A fresh installer chooses an available 2.x stable release, then beta, then alpha when no later release phase exists.

To use another channel for one update:

```bash
myco update --channel beta
```

This does not change the recorded channel. An explicit channel on a repeat install does.

## Update runners

Installed runners check for releases and update themselves **between runs**, within their recorded channel. In **Runners**, an owner or administrator can choose **Update now** when a connected runner reports an available update. A busy runner finishes its run first. The page shows its version, channel and last update result.

An installed runner on the same machine keeps updating between runs even when automatic member updates are off.

On the runner machine, `myco update` also queues the service's update between runs. For checks and recovery details, see [Runner updates](runners.md#updates-between-runs). On a machine that both captures and runs tasks, an update handoff can leave agent refresh pending; finish with an interactive `myco update` or `myco member provision --refresh` after the handoff.

## Update a Deployment

An update from schema 101 or earlier to schema 104 or later refuses `thin_learning_stepping_stone_required`: Update to 2.0.0-alpha.13 first (schema 103), let in-flight learning runs finish or lapse, then update again. New empty Deployments can be created directly. Recovery can migrate a verified private staging copy directly; it refuses in-flight extraction before applying the pause migration and checks drain admission before publication.

If an update from schema 102 or 103 refuses `thin_learning_not_drained`, let in-flight learning runs finish or lapse under the current version, then retry. These preflight refusals leave the database at its original schema version. `thin_learning_pause_required` means the learning pause marker is missing or invalid; restore the valid Deployment state before retrying.

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

An existing npm-installed 1.4 uses the same managed binary destination. Run the installer with explicit replacement, then complete setup and cutover; the 1.4 updater stays on its own release line. Existing npm-installed 2.x alphas can use `myco update`, which downloads verified GitHub assets directly.

Keep a backup of the 1.4 home. Installing 2.0 replaces the binary immediately; old hooks stop capturing until sign-in and cutover finish. The installer preserves a recognized 1.4 installation unless you explicitly pass `--replace-1.4`. It keeps and refuses an unrecognized binary rather than guessing.

Preview the replacement, then install and start guided setup:

```bash
curl -fsSL https://myco.sh/install.sh | sh -s -- --dry-run --replace-1.4
curl -fsSL https://myco.sh/install.sh | sh -s -- --replace-1.4
myco setup
```

To choose a release phase explicitly, set `MYCO_CHANNEL=beta` or `MYCO_CHANNEL=alpha` on `sh`. On Windows x64, use the PowerShell installer's `-Replace14` option; that Windows cutover path is not yet verified.

Setup detects 1.4 data and agent connections by reading files; it never executes a 1.x binary. It continues from the Deployment and connections already on this machine, asking you to choose when there is more than one possible next step. It helps you sign in to an existing Deployment or create one, previews the cutover, asks you to approve that exact plan and runs the existing cutover operation. Each project has its own destination, so one move can cover several Deployments. Sign in to every destination first. Projects with no route require an explicit destination or skip choice. With several signed-in Deployments, setup also asks about projects that would otherwise fall back to the default; without a terminal, pass `--route` or `--skip`.

For an existing Deployment:

```bash
myco setup --join <address> --cutover
myco setup --status
```

For routes across several Deployments, sign in to the other destination before setup:

```bash
myco login <other-address>
myco setup --join <address> --cutover --route <project-id>=<other-address> --skip <other-project-id> --yes --no-runner
myco setup --status
```

Run `myco setup` again to resume. `--yes` accepts a printed first plan; a changed source, destination, skip choice or capture agent set requires fresh interactive approval. Capture written during this run’s handover moves too when the projects and destinations are unchanged; setup records the stopped source and reports how many sessions were added. `--no-agents` declines installing 2.0 agent integrations during the handover. `--no-cutover` leaves the migration pending and stops setup before the agents, project and runner steps. Status is strictly read-only. If 1.4 wrote more data after migration, keep its files and run `myco setup --cutover` to review the new plan. Setup names partial imports and remaining work so you can fix the reported problem and rerun.

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

### Earlier copies on another Myco

If an earlier move also copied history to another Deployment, Myco reports that copy and leaves it alone. After you have reviewed or removed it on that Deployment, acknowledge the copies currently reported:

```bash
myco cutover --dismiss-earlier-copies
```

This only stops reporting those recorded copies on this machine. It contacts no Deployment and deletes no history. New or changed copies are reported again. Use this separately from a preview or move; only `--legacy-home <dir>` can accompany it.

### What moves, and how to check it

Cutover writes backups of changed agent settings and the 1.4 service under `~/.myco/backups/cutover-<stamp>/`, with a `restore.md` containing commands to undo those changes. The installer keeps the executable it replaces. If the service’s 1.x executable is still in place, undo leaves it there. Otherwise, undo restores an identified saved executable at the service’s exact path before starting it, explicitly replacing 2.0 there. Saved copies must agree with the recorded executable identity; a mismatched copy is never restored. If no saved executable can be identified, the instructions list the choices or give a checksum-verified 1.4 reinstall step; they use the recorded version when available and otherwise say to use the latest 1.4 release. Keep that folder and read its recovery instructions before undoing a move. Cutover connects the old project folders, hands agent configuration to 2.0 and stops the 1.4 service. It then copies and verifies each old vault before importing project history and agent transcripts. The original vaults stay in place. Copies and imports can resume when you rerun the command.

Receipts in `~/.myco/member/cutover.json` record destinations, verified copies, history import and transcript progress separately. A partial or refused import is unfinished, even if agent setup succeeded. Fix the named problem, preview again and rerun with the same routing choices. If a repository now points elsewhere than its receipt, confirm the new destination with `--route` or leave it with `--skip`.

Setup and status can check an earlier move with its destination. Missing evidence, a timeout or an expired sign-in leaves the move unconfirmed; follow the reported next step and keep the 1.4 files. A completed history import does not prove the separate transcript import has finished. If its destination was archived or deleted after history finished moving, Myco reports that state and stops trying to import transcripts there.

Old extra plan folders are reported, not silently copied into machine settings. Add the ones you still want under **My machines** → **Extra plan folders**. Configure the Deployment's models and schedule in **Settings** and register a [runner](runners.md); moving history does not enroll a runner.

Run `myco doctor` and `myco member status`. In the dashboard, check each destination's projects, sessions, spores and plans, then start a new coding session and confirm it appears on **Today**. Keep 1.4 data and the cutover copies until you have verified both history and new capture.

Start a new coding-agent session after moving; an already-open session keeps its earlier Myco connection. For maintaining an installation that stays on 1.4, use the [1.4 documentation](https://github.com/goondocks-co/myco/tree/release/1.4/docs).
