# Guided setup fixtures

These fixtures supply the state and boundaries for setup journey tests. They do
not implement setup or claim the later journeys pass.

- `github.ts` supplies the registration conversion and both OAuth identities.
  Inject its fetch into `registerGitHubApp` and `createBunHandler`; unexpected
  requests throw. The same outbound fetch works with the D1 server adapter.
- Native service operations use the existing `ServiceOptions.runner` seam and
  `recordingPlatform()` from `tests/helpers/fake-service-manager.ts`. Pass the
  resolved Myco home as `defaultSpec`'s fourth argument. Omission retains the
  production default specification. The containment gate is
  `tests/meta/service-exec-boundary.test.ts`.
- `misleading-history.ts` seeds a relational store with imported sessions, empty
  completed work, an offline runner's old offer and another machine's claim.
  Checklist tests must use the production capture, outcome and readiness reads.
- `interrupted-state.ts` creates persisted native, owner, approval and runner
  states through their current owners. Use a fresh empty Deployment for the
  expired first-owner link. Advance the test clock; no real waiting is needed.
  Its converted-app fixture writes a private `sign-in-pending.json` artifact;
  it seeds the design's future recovery state under `LocalVolume` ownership.
  Current registration does not persist or consume that artifact. The future
  sign-in recovery operation owns producing, consuming and removing it.
  E5 must replace this hand-written fixture with its production writer so journey
  tests use the persisted shape that sign-in recovery actually reads.
- `cutover.ts` seeds membership for one or two fake destinations, records the
  first project's accepted history through `LegacyLedger`, and leaves the next
  project unrecorded. It also supplies a third legacy project with an explicit
  skip decision and its real `MemberSpool`.
  Journey tests can snapshot that spool and vault before resuming cutover.
- `interruption.ts` provides one-shot checkpoints for every acceptance
  interruption, including conversion before credential installation and cutover
  between projects or destinations. Insert the checkpoint in injected operations
  after the preceding operation commits. Reuse it on resume. `refuseImportAfter`
  returns a terminal 403 after accepted requests through an explicitly supplied
  fake transport; it never falls back to the network.

## Legacy home specification

Allocate a root under the canonical test runner's temp root, then call
`legacyFixtureHome(root)`. It contains a v76 vault made from the existing frozen
SQL fixture, two project folders with sessions, prompts and spores, a legacy
configuration ownership claim, Claude hooks and MCP, Codex MCP, and launchd and
systemd unit **files**. Its `env` supplies every child home and temp variable.
Run child commands with this environment and `cwd: root`.

The managed binary path contains a non-executable presence marker. Tests must
never execute it or submit these units to a service manager. Preserve the vault,
unrelated configuration and skipped project's spool byte for byte across retry.
Use separate fake Deployment destinations for the two projects to exercise an
interruption between destinations. A membership without migration receipts must
leave the vault discoverable; neither membership nor a backups-only cutover
record proves migration is complete.

The manual acceptance baseline is different: a signed 1.4.8 installed and used
inside a disposable VM. Only that VM supplies evidence about a real 1.4 install;
this file-only host fixture supplies no such evidence.
