# Test temp isolation

Use `npm test -- <files>` for focused runs and `npm test` for the full suite.
Watch, parity, Node, jsdom and the Windows CI contracts use the same runner.
Screen tests use `run-test-command.mjs`, which shares its temp root, sandbox
home and exit gate. Bundle generation runs inside the Bun test runner's root.
The retained `tests/setup/vitest.ts` is loaded by the Bun jsdom setup; there
is no separate active Vitest runner in this checkout.

The runner creates one `mt-*` root before starting any test runtime. Its
preloads establish a fallback root before sandbox creation for direct test
invocations. Fixtures that resolve `os.tmpdir()` at module load therefore use
the root. The test-only subprocess boundary supplies `TMPDIR`, `TEMP` and
`TMP` to Node and Bun subprocess APIs, including replacement environments;
an explicitly supplied temp directory inside the root remains valid.
Compiled executables and harness stubs receive these variables at startup.

At exit, the runner compares `myco-*` and `mt-*` names in the inherited temp
directory and OS default temp directories with its startup snapshot. New
entries born during the run fail the run even when every test passed. The
gate reads these directories but removes only its own root; escaped entries
remain available for diagnosis. Pre-existing names and live sibling runner
roots (identified by their `.owner` PID) do not count.

There is no portable creator-PID metadata for an arbitrary closed file or
directory. A concurrent process creating an unmarked `myco-*` entry can
therefore fail another run's gate. Names already present in the snapshot,
entries with older birth times, unrelated prefixes and live sibling roots
are excluded. Concurrent lanes should each supply their own scratch temp
parent. On filesystems without birth times, the snapshot alone bounds age.
