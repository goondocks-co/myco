# Persistent macOS worker smoke rig

Agent work requires explicit owner opt-in with `myco runner register <host>`, then `myco runner install --server <url>`. Member join installs no executor and developer laptops run nothing by default. This retained legacy-member rig is a separate opt-in smoke harness for boot-scope and crash-recovery checks; it is not the runner installation path. The opt-in rig runs an installed `myco worker` through the existing service manager and restarts it after a crash. Choose `login` to start with a user session or `boot` to start when the machine boots. Both run as the invoking user. The rig does not start a Deployment or a capture daemon, and it does not configure host VM startup or automatic login.

Use a reviewed, signed native binary in a persistent directory. Keep its membership home, working directory and logs outside temporary directories and source checkouts. The service gets only the declared home and PATH. It reads credentials from the membership registry and the harness's ordinary login store. No credential is embedded in the service definition.

On the rig, create the working directory and select the exact installation:

```sh
mkdir -p "$HOME/myco-rig/worker"
export MYCO_SMOKE_BINARY="$HOME/myco-rig/bin/myco"
export MYCO_HOME="$HOME/myco-rig/member"
export MYCO_SMOKE_ROOT="$HOME/myco-rig/worker"
export MYCO_SMOKE_SERVER="https://your-deployment.example"
export MYCO_SMOKE_HARNESS="codex"
export MYCO_SMOKE_START_AT="boot"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
npm run smoke:worker-service -- plan
```

The selected membership must already be joined. `plan` verifies persistent paths, membership and the actual binary's harness detection in the service environment, then prints the service definition. Detection alone does not prove a provider request will work. Boot installation requires administrator access through the existing service backend. Run the command as the intended worker user, never as root; the backend elevates only the unit installation and supervisor operations. It refuses installation if elevation is unavailable.

After reviewing that output, use the same environment:

```sh
npm run smoke:worker-service -- install
npm run smoke:worker-service -- status
```

The label is derived from the Deployment, membership home and rig directory. An existing installation in either startup scope is refused so a rerun cannot interrupt an active task or create a second copy at boot. To change scope, explicitly uninstall the old scope first. Installation status proves attachment only after `worker.log` shows a response from the Deployment. A running PID alone is insufficient.

For a VM without a checkout, bundle the rig command on the development machine and copy the output to the VM. The worker itself still runs the native binary:

```sh
bun build scripts/smoke-worker-service.ts --target=bun --outfile=worker-service.mjs
# Copy worker-service.mjs to the rig, then use its configured environment:
bun --no-env-file worker-service.mjs plan
bun --no-env-file worker-service.mjs install
```

## Verify continuity and useful work

Record the native binary hash/version, server version, membership home, service label, harness version, boot time and worker PID. Queue an owner-requested task through the dashboard and verify its actual artifacts with the MCP verifier used by `npm run smoke:worker`, then inspect the result in the dashboard. An already-seeded project can legitimately produce a skip report, provided the persisted state supports it.

When idle, kill only the recorded rig worker PID with SIGKILL. Verify that the service starts a different PID, that it receives a Deployment response, and that a subsequent real task produces matching artifacts. Killing a busy worker requires a separate lease-recovery check before assuming the run was recovered.

Reboot the test VM and verify the boot timestamp changed. For boot scope, inspect the service and prove another actual task before anyone logs in. For login scope, do the same after user login and record that dependency. A manual worker start after reboot does not establish automatic service recovery. A suspended VM and an exited worker are separate failure modes.

To remove this rig service, use the same environment and run:

```sh
npm run smoke:worker-service -- uninstall
```

Removal affects only this rig's unit. It preserves sibling Myco services, the membership, logs and captured data. Service registration, bounded crash recovery and bounded reboot recovery are separate from the sustained daily-use acceptance gate.

## Replace the binary under a running worker

Put the new build beside the old one, prove it runs, then rename it over the old one. The rename gives the new program a fresh inode, so the running worker keeps its own image, and a hook never runs a half-written file:

```sh
BIN="$HOME/myco-rig/bin/myco"   # the path the unit runs
cp /path/to/new/myco "$BIN.new" && chmod 755 "$BIN.new" \
  && codesign --verify --strict "$BIN.new" && "$BIN.new" --version \
  && mv -f "$BIN.new" "$BIN"
```

On Linux, leave out the `codesign` step. On macOS, if `codesign --verify --strict` fails, the kernel will kill the program when it runs. If `codesign -dv "$BIN.new"` shows `Signature=adhoc`, sign it ad hoc again with `codesign --force --sign - --preserve-metadata=entitlements,identifier "$BIN.new"`, then run the line again. Never re-sign a binary that carries a certificate's signature; get a good build instead.

The worker notices the new program before its next claim. It runs the new program's `--version`, and stays on the old program if that fails. On macOS it then asks launchd to load its unit again, and the new program starts within seconds. Plain restarts go wrong on macOS. A LaunchAgent that launchd loaded at login carries the code requirement that Background Task Management recorded for its program. For an ad hoc signature that requirement is the program's hash. launchd's own restart of a replaced program is killed with `OS_REASON_CODESIGNING` ("Launch Constraint Violation" in the crash report), and it starts only on the retry a restart delay later. A worker built before this behavior existed does not reload itself, so load its unit again yourself after the rename:

```sh
launchctl unload ~/Library/LaunchAgents/<label>.plist && launchctl load -w ~/Library/LaunchAgents/<label>.plist
```

`launchctl kickstart -k` is not a substitute. It restarts the unit under the recorded requirement, and the kernel kills that start.
