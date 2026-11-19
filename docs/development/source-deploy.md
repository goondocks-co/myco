# Deploy a source build to your Cloudflare Deployment

On the main checkout on macOS, with the Bun version in `.bun-version` first on PATH, run:

```sh
make source-deploy COMMIT=<full-40-hex-commit>
```

This owner command installs into your selected Myco home and updates its recorded Cloudflare Deployment using
your operator sign-in. It refuses CI, linked worktrees, any branch other than `main`, tracked or untracked changes,
a missing or mismatched commit, and a different Bun version, before building or installing. It calls
`make source-install` once; that target owns asset preparation, compilation, verification and guarded installation.

After installation it rechecks the checkout, verifies the installed source marker's checkout, full commit and
binary hash, checks the installed macOS signature with `codesign --verify --strict`, and verifies `--version`
against that marker. Failure stops before the next phase. The verified version and commit are printed.

The installed absolute binary runs `myco server update --target cloudflare` from your home directory so a
repository's Cloudflare dotenv token cannot override the operator's sign-in. A successful update prints its
applied Worker version and schema summary; the following `myco server status --target cloudflare` prints the
live Worker version and schema. Read unavailable or unconfirmed status as such; the command does not claim
successful observation when the provider could not be read. On an interrupted update, follow its printed recovery
or rerun command. It preserves the existing server lifecycle's migration, bookmark and activation checks.

This target is never called by CI. Validate its refusals with isolated homes and fake commands, never Cloudflare.
For isolated worktree builds, use [the dogfood skill](../../.agents/skills/dogfood-worktree/SKILL.md).
