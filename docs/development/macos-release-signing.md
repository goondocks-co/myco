# macOS release signing

The release workflow cross-compiles binaries on Ubuntu, then signs both
`darwin-arm64` and `darwin-x64` on `macos-14` with
`codesign --force --sign - --preserve-metadata=entitlements,identifier binary/myco`.
The signature retains the compiled executable's entitlements and identifier.
This is ad hoc signing; it requires
no Developer ID secrets and does not notarize the binaries.

The signing job replaces the cross-compiled artifacts. The build job waits
for signing to succeed before downloading those artifacts, staging raw
release assets or running `npm pack`. SHA256SUMS is computed from those
signed bytes by the GitHub release job.

Artifact ZIP transport drops executable permissions. The build restores
them before packing; the gate restores the raw asset's executable bit and
requires the npm binary to already carry executable permissions in the tarball.

Before either GitHub or npm publication, the `verify-darwin` job downloads
the exact `myco-raw-binaries` and `npm-package` artifacts on `macos-14`.
`scripts/verify-darwin-distribution.sh` extracts each platform package's
`package/bin/myco`, requires byte identity with its staged raw asset, and
runs `codesign --verify --strict` on both. For arm64 it also executes each
binary with `--version` and requires the exact tag version. A failure or
skipped gate blocks publication of Myco. Internal `myco-shared` releases
do not produce native binaries and skip this gate.

The x64 signatures and byte identity are required too. Execution of x64 is
explicitly skipped because Bun x64 raises SIGILL under the macos-14
runner's Rosetta (also documented in the CI hook-startup matrix). Native
x64 execution remains a release validation limit.

Main pushes and PRs build darwin-arm64 in the CI `hook-startup` matrix.
The existing build signer signs the binary and retains its entitlements;
that job then stages a raw copy, packs the platform package,
and uses the same verifier with an explicit smoke version, `0.0.0-ci`,
set before compilation to avoid development-version git stamping. CI's aggregate
requires that job. CI does not build a darwin-x64 binary.

Keep the ad hoc signing in `docs/install.sh` as an installation defence.
Workflow contract tests in `tests/meta/release-workflow-contract.test.ts`
reject omitted signing, signing moved after packing or checksums, and
removed or bypassed publication gates.
