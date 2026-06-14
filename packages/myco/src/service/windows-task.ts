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

  return [
    '@echo off',
    ...setLines,
    `cd /d "${spec.workingDir}"`,
    `${exec} >> "${spec.stdoutPath}" 2>> "${spec.stderrPath}"`,
    '',
  ].join('\r\n');
}
