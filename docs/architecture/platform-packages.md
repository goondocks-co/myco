# Per-Platform npm Packages

`@goondocks/myco` ships as a small JavaScript shell that resolves a
platform-specific binary at install time. The binary itself lives in one of
five sibling packages on npm — only the matching one is installed on each
user's machine.

```
@goondocks/myco                  ← core: bin/, dist/, scripts/, skills/, no binary
@goondocks/myco-darwin-arm64     ← binary only, ~30 MB packed
@goondocks/myco-darwin-x64       ← ditto
@goondocks/myco-linux-x64        ← ditto
@goondocks/myco-linux-arm64      ← ditto
@goondocks/myco-windows-x64      ← ditto
```

This is the same pattern esbuild, swc, rollup, and the Bun runtime use.

## Why

Before this split, `@goondocks/myco` bundled all five cross-compiled Bun
binaries into a single ~200 MB tarball. Every user downloaded four
binaries they'd never run. After the split:

- Per-user install: ~200 MB → ~30–40 MB (5–6× smaller).
- The 210 MB CI tarball guardrail drops to 50 MB for core, 60 MB per
  platform package.
- A Bun-runtime bump no longer threatens the npm publish ceiling.

## How resolution works

1. Each platform package declares matching `os` and `cpu` fields in its
   published `package.json`. npm installs only the one whose constraints
   match the host; the others are skipped via `optionalDependencies` plus
   the os/cpu filter.
2. The core package's `postinstall` runs
   `packages/myco/scripts/select-binary.mjs`, which calls
   `require.resolve('@goondocks/myco-<target>/bin/<bin>')` to find the
   binary that npm installed. It writes
   `packages/myco/vendor/resolved.json` with the absolute `binaryPath`.
3. The bin shim `packages/myco/bin/myco.cjs` reads `resolved.json` and
   `execFileSync`s the binary with forwarded argv.

## Why os/cpu are NOT in source

Workspace installs validate `os`/`cpu` on every linked workspace —
declaring `darwin-x64` in source would break `npm install` for everyone
on darwin-arm64. The fields are injected just before `npm pack` by
`scripts/inject-platform-metadata.mjs`, which the release workflow
calls for each target. Source-tree `package.json`s stay platform-neutral.

## Release flow

The single tag `myco/vX.Y.Z` triggers the entire release. The CI workflow:

1. **Cross-compile** the binary for each target into the matching
   `packages/myco-<target>/bin/`. Each target uploads its `bin/` as a
   GitHub Actions artifact.
2. **Sync versions** with `scripts/sync-package-versions.mjs --target
   myco --version <version>`. This bumps every `package.json` in the
   `myco` family — including the five platform package.json files — and
   rewrites `optionalDependencies` in `packages/myco/package.json` so
   core pins each platform package to the same exact version.
3. **Stage binaries** back into their per-platform package directories.
4. **Inject `os`/`cpu`** into each platform package.json
   (`scripts/inject-platform-metadata.mjs <target>`).
5. **Pack** each platform package and core (six tarballs total).
6. **Publish** the five platform packages to npm first, then core.
   Platform-first ordering matters: if core were published first, fresh
   installs would fail to resolve the optionalDependencies until the
   platform packages caught up.

The release workflow lives in `.github/workflows/publish.yml`.

## Dev / source-checkout behavior

For local development:

- All five platform packages are workspaces, symlinked into
  `node_modules/@goondocks/` by `npm install`.
- The binary for the host target is written into
  `packages/myco-<host>/bin/myco` by `make dev-link` (which invokes
  `scripts/build-single-target.mjs`).
- After the binary lands, `make dev-link` re-runs
  `scripts/select-binary.mjs` so `vendor/resolved.json` is populated for
  callers that go through `bin/myco.cjs`. (Bench dev typically reaches
  the binary via `~/.local/bin/myco-dev`, the direct symlink, but tools
  that go through the npm bin shim need `resolved.json`.)
- Before the binary is built, `select-binary.mjs` detects the
  source checkout (presence of `packages/myco/src/`) and exits 0 with a
  warning rather than failing the postinstall — so a clean `npm ci` on
  the monorepo doesn't break.

## Adding a new target

To support an additional `os`/`cpu`:

1. Create `packages/myco-<target>/` with a `package.json` matching the
   existing platform packages (no `os`/`cpu` in source).
2. Add the package to `optionalDependencies` in
   `packages/myco/package.json`.
3. Add the target to:
   - `PLATFORM_METADATA` in `scripts/inject-platform-metadata.mjs`
   - `MYCO_PLATFORM_OPTIONAL_DEPS` and the `myco` target's `files`
     list in `scripts/sync-package-versions.mjs`
   - `MYCO_PLATFORM_OPTIONAL_DEPS` consumers in the publish workflow
     (cross-compile matrix, "Verify platform binaries" step, "Pack
     platform packages" step, publish step)
   - `VALID` in `packages/myco/scripts/build-single-target.mjs`
   - the platform pattern in
     `packages/myco/src/service/spec-builder.ts#looksLikeDevBuildExecutable`
4. Provide a Bun cross-compile target plus libsqlite3 build for the
   architecture.
