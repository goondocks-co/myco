# macOS release signing

The release workflow cross-compiles binaries on Ubuntu, then signs both
`darwin-arm64` and `darwin-x64` on `macos-14` with
`scripts/sign-darwin-binary.sh`, the same entry point the CI release-recipe job uses.
It runs `codesign --force --sign - --preserve-metadata=entitlements,identifier`.
The signature retains the compiled executable's entitlements and identifier.
This is ad hoc signing; it requires
no Developer ID secrets and does not notarize the binaries.

The signing job replaces the cross-compiled artifacts. The build job waits
for signing to succeed before staging raw assets and computing SHA256SUMS.

Artifact ZIP transport drops executable permissions. The verifier checks
strict code signatures and matches the downloaded bytes against SHA256SUMS,
then restores the executable bit. It executes arm64 with --version and
requires the exact release version. Any failure blocks publication.

The verify-darwin job checks the exact myco-raw-binaries artifact on macos-14.

The x64 signatures and checksums are required too. Execution of x64 is
explicitly skipped because Bun x64 raises SIGILL under the macos-14
runner's Rosetta (also documented in the CI hook-startup matrix). Native
x64 execution remains a release validation limit.

Main pushes and PRs build darwin-arm64 in the CI `hook-startup` matrix.
The existing build signer signs the binary and retains its entitlements;
that job then stages a raw copy and computes its checksum,
and uses the same verifier with an explicit smoke version, `0.0.0-ci`,
set before compilation to avoid development-version git stamping. CI's aggregate
requires that job. Every main push, and PRs changing workflows, actions, scripts,
package manifests or lockfiles, or `.bun-version`, also exercise the release recipe:
`darwin-release-build` cross-compiles arm64 on Ubuntu using the native library
artifact from `hook-startup`; `darwin-release-verify` signs it on macos-14 via
the shared script, stages it with its checksum, and executes the distribution verifier. The aggregate
admits skipped recipe jobs only when the path selector explicitly says they are
not required; failed or cancelled jobs always fail it. CI does not build a
darwin-x64 binary; x64 signing is checked by the release matrix and the local
arm64-host signing probe. Binary execution in the verifier uses its own scratch
working directory.

Keep the ad hoc signing in `docs/install.sh` as an installation defence.
Workflow contract tests in `tests/meta/release-workflow-contract.test.ts`
reject omitted signing, signing moved after staging or checksums, and
removed or bypassed publication gates, `continue-on-error`, and commands that
swallow signing or verification failures. Ordering mutations relocate the signing
step after the actual staging or checksum command; the needs graph and signing-job
step order reject those moves.
