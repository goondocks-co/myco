# Platform release assets

Myco releases ship as five native GitHub release assets plus SHA256SUMS.
Install with [install.sh](../install.sh) or [install.ps1](../install.ps1);
neither Node nor a package manager is required on the destination machine.

| Target | Asset |
| --- | --- |
| macOS arm64 | myco-darwin-arm64 |
| macOS x64 | myco-darwin-x64 |
| Linux x64 | myco-linux-x64 |
| Linux arm64 | myco-linux-arm64 |
| Windows x64 | myco-windows-x64.exe |

macOS is the primary supported platform. Linux and Windows are in beta;
Windows on ARM is unsupported.

## Release flow

A myco/vX.Y.Z tag runs .github/workflows/publish.yml. PRs and manual
dispatches run its build, signing and verification recipe without publication.

1. Compile native SQLite and cross-compile each binary into its
   packages/myco-<target>/bin directory.
2. Sign both macOS artifacts before staging the final release assets.
3. Verify compiled versions and smoke the Linux database and HTTP server.
4. Stage all five canonical asset names and compute SHA256SUMS from those bytes.
   Verify exactly those five entries and their bytes before uploading the artifact;
   PR and manual dry runs execute this check, as does release creation.
5. Verify the transported macOS assets against the manifest and strict signatures.
   Execute arm64 with --version; x64 signature verification remains mandatory,
   while execution is skipped on the macOS runner's incompatible Rosetta runtime.
6. Require successful exact-commit main CI, collect every required asset,
   attach them to a draft GitHub release, then publish it.

Only myco/v* release tags and the manual version input are admitted. The internal
myco-shared workspace is built by normal repository builds and has no release tag
trigger or dispatch choice. Git plugin versions use plugin-version.json and
scripts/prepare-plugin-release.mjs independently of binary version stamping.

## Installation and updates

POSIX installs use <MYCO_HOME>/bin/myco; Windows uses
<LOCALAPPDATA>/Myco/bin/myco.exe. Installers verify checksums and probe the new
binary before replacement. Existing Myco 1.4 installations require explicit
replacement before [cutover](../upgrade.md#upgrading-from-myco-14).

Member updates use verified GitHub release assets through the guarded updater.
This also applies to existing 2.x installations originally installed through npm.
Legacy origin metadata remains readable; no new package bootstrap is required.

## Source workspaces

The five platform workspace directories remain build-output locations.
Their manifests stay platform-neutral so installing repository dependencies
works on every supported development host.

- make source-build prepares native SQLite, the dashboard and generated carriers,
  then builds and verifies packages/myco-<host>/bin/myco without installing.
- make source-install uses the candidate's guarded updater to install into the
  selected home. Worktree installs require ALLOW_WORKTREE_INSTALL=1.
- Plain myco update returns a source install to its selected channel release.
  Automatic updates skip source builds.
- Worktree smokes use absolute artifacts, scratch homes including LOCALAPPDATA,
  and a scratch cwd. See the dogfood-worktree skill.
- Windows uses artifacts cross-built on macOS/Linux; see
  [Contributing](../../CONTRIBUTING.md#source-builds-on-windows).

Adding a target requires a workspace/output directory, a Bun compile target,
native assets, build/release matrices, an installer target and verification.
