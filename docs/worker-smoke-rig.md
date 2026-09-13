# Persistent macOS worker smoke rig

The opt-in rig runs an installed `myco worker` through the existing service manager and restarts it after a crash. Choose `login` to start with a user session or `boot` to start when the machine boots. Both run as the invoking user. The rig does not start a Deployment or a capture daemon, and it does not configure host VM startup or automatic login.

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
