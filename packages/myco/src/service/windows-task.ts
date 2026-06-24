import type { ServiceSpec } from './types.js';

/**
 * Render the Windows launcher batch script that the Task Scheduler task runs.
 * Mirrors `renderSystemdUnit` / the launchd plist: bake the env, working dir,
 * exec, and log redirection into one artifact so the task definition only has
 * to point at this file. Task Scheduler cannot set environment variables on a
 * task, which is why the env lives in a launcher script rather than the task.
 *
 * `PATH` is intentionally NOT injected. The service spec's PATH is the
 * POSIX fallback (`/usr/local/bin:/usr/bin:...` — see `spec-builder.ts`), which
 * is meaningless on Windows, and a logon-triggered task already inherits the
 * user's real PATH (with git, etc.). The launchd/systemd PATH override exists
 * to repair the stripped PATH a GUI launch agent gets; that problem doesn't
 * apply to a Task Scheduler logon task.
 *
 * CRLF line endings: `cmd.exe` is whitespace/line-ending sensitive.
 */
export function renderWindowsServiceScript(spec: ServiceSpec): string {
  const setLines = Object.entries(spec.env)
    .filter(([key]) => key !== 'PATH')
    // `set "K=V"` quoting keeps spaces/special chars literal and is the
    // canonical cmd.exe form for values that may contain `&`, `(`, etc.
    .map(([key, value]) => `set "${key}=${value}"`);

  const exec = `"${spec.executable}" ${spec.args.join(' ')}`;
  const run = `${exec} >> "${spec.stdoutPath}" 2>> "${spec.stderrPath}"`;

  // Non-keepAlive: run once, no supervision.
  if (!spec.keepAlive) {
    return ['@echo off', ...setLines, `cd /d "${spec.workingDir}"`, run, ''].join('\r\n');
  }

  // KeepAlive: supervise the daemon the way launchd KeepAlive / systemd
  // Restart=on-failure do. Restart on a CRASH (any non-zero exit — including the
  // 0xC0000005 access violation bun:sqlite can intermittently throw under
  // x64-on-ARM emulation during a heavy startup replay), but stop on a clean
  // shutdown (exit 0, e.g. `myco daemon kill` or a step-aside). Bounded so a
  // permanently-failing binary can't hot-loop; the intermittent fault clears
  // within a couple of tries. `ping` is the sleep — `timeout` needs a console a
  // logon task doesn't have. `%errorlevel% equ 0` (not `if errorlevel 1`) so a
  // negative crash code still counts as failure.
  const backoffPings = Math.max(2, (spec.throttleSeconds || 2) + 1);
  return [
    '@echo off',
    ...setLines,
    `cd /d "${spec.workingDir}"`,
    'set MYCO_RESTARTS=0',
    ':myco_run',
    run,
    'if %errorlevel% equ 0 goto myco_done',
    'set /a MYCO_RESTARTS+=1',
    'if %MYCO_RESTARTS% geq 10 goto myco_done',
    `ping -n ${backoffPings} 127.0.0.1 > nul`,
    'goto myco_run',
    ':myco_done',
    '',
  ].join('\r\n');
}
