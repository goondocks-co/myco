# Test temp isolation

Use `npm test -- <files>` for focused runs and `npm test` for the full suite.
Watch, parity, Node, jsdom and the Windows CI contracts use the same runner.
Screen tests use `run-test-command.mjs`, which shares its temp root, sandbox
home and exit gate. Bundle generation runs inside the Bun test runner's root.
Set `PLAYWRIGHT_BROWSERS_PATH` to an installed browser directory for screen
tests. CI installs and caches Chromium at `target/playwright-browsers` with
that explicit setting; browser lookup does not depend on the sandbox home.
The retained `tests/setup/vitest.ts` is loaded by the Bun jsdom setup; there
is no separate active Vitest runner in this checkout.
CI shard discovery uses the command wrapper; parity manifests return on
stdout through the Bun runner rather than writing into another run's root.

The runner creates one `mt-*` root before starting any test runtime. Its
preloads establish a fallback root before sandbox creation for direct test
invocations. Fixtures that resolve `os.tmpdir()` at module load therefore use
the root. The test-only subprocess boundary supplies `TMPDIR`, `TEMP` and
`TMP` to Node and Bun subprocess APIs, including replacement environments;
an explicitly supplied temp directory inside the root remains valid.
Compiled executables and harness stubs receive these variables at startup.
Every Bun test preload installs the filesystem fence before test modules
load, using system directories captured by the runner before it changes
`TMPDIR`. Its shared fs/Bun mutation guard refuses creating `myco-*` and `mt-*`
entries under a system temp directory outside that process's run root,
including recursive parent creation and symlink aliases. Existing enclosing
scratch directories, including enclosing runner roots, can hold explicitly
addressed ordinary report files. Matching leaf entries and missing matching
parents remain blocked. The exception identifies the API, path and caller stack.
Standalone native-lock test children install the same guard.
Native per-user lock tests inject the existing lock namespace; the preload
fences the fixed POSIX native lock root. Native path assertions verify a
runner-owned filesystem fixture.

On Windows, Bun's preload reads child creation FILETIME through Win32;
Node runners use PowerShell 7 (`pwsh`). Both record the PID and creation
identity under the root, including the long-lived screen server.
Cleanup holds a process handle and checks that identity before
terminating a registered process tree, including a server whose parent has
exited. Arbitrary unregistered descendants of an already-exited Windows
parent cannot be proven owned from reused parent PIDs. Raw Bun fallback
cleanup runs in its final test hook; Windows handles still held by Bun may
cause cleanup to fail and leave a root for the next run's stale-root sweep.
Cleanup retries transient file locks within a bound and reports the exact
file's process owners if a Windows lock persists. Git capability probes
initialize disposable repositories; `git <command> --help` opens browser
help and must not be used as a test capability probe.

At exit, the runner compares `myco-*` and `mt-*` names in the inherited temp
directory and OS default temp directories with its startup snapshot,
including Darwin's `getconf DARWIN_USER_TEMP_DIR`. New entries born during
the run produce a warning locally. They fail a CI run, where the machine is
owned by one run, or a run started with `MYCO_TEST_STRICT_TEMP=1`. The scan
reads these directories but removes only its own root; observed entries
remain available for diagnosis. Pre-existing names and live sibling runner
roots (identified by their `.owner` PID) do not count. Stale-root cleanup
removes only directories with a valid, provably dead owner PID; files,
symlinks, missing or unreadable owners, and unknown liveness are retained.
Unexpected owner-read or PID-check failures are reported as warnings.

There is no portable creator-PID metadata for an arbitrary closed file or
directory. The local snapshot therefore reports observations rather than
attributing another process's entry to the test run. The preload attributes
blocked mutations to the test process at their source. Names already present
in the snapshot, entries with older birth times, unrelated prefixes and
live sibling roots are excluded. An isolated scratch temp parent contains
the run's own files; it does not suppress inspection of OS defaults. On
filesystems without birth times, the snapshot alone bounds age.
