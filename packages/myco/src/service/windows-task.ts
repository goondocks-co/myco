import type { ServiceSpec } from './types.js';

/**
 * Render the Windows PowerShell launcher that the Task Scheduler task runs.
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
 * CRLF line endings keep the installed script native to Windows tooling.
 */
export function renderWindowsServiceScript(spec: ServiceSpec): string {
  const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const unsupportedArgument = spec.args.find(
    (argument) => argument === '' || /[\s"]/.test(argument),
  );
  if (unsupportedArgument !== undefined) {
    throw new Error(
      `Windows service argument requires unsupported command-line quoting: ${JSON.stringify(unsupportedArgument)}`,
    );
  }
  const environmentLines = Object.entries(spec.env)
    .filter(([key]) => key !== 'PATH')
    .map(([key, value]) => (
      `  $startInfo.EnvironmentVariables[${literal(key)}] = ${literal(value)}`
    ));

  const preamble = [
    "$ErrorActionPreference = 'Stop'",
    `$executable = ${literal(spec.executable)}`,
    `$arguments = @(${spec.args.map(literal).join(', ')})`,
    `$workingDirectory = ${literal(spec.workingDir)}`,
    `$stdoutPath = ${literal(spec.stdoutPath)}`,
    `$stderrPath = ${literal(spec.stderrPath)}`,
    'function Invoke-MycoProcess {',
    '  $startInfo = New-Object System.Diagnostics.ProcessStartInfo',
    '  $startInfo.FileName = $executable',
    "  $startInfo.Arguments = $arguments -join ' '",
    '  $startInfo.WorkingDirectory = $workingDirectory',
    '  $startInfo.UseShellExecute = $false',
    '  $startInfo.CreateNoWindow = $true',
    '  $startInfo.RedirectStandardOutput = $true',
    '  $startInfo.RedirectStandardError = $true',
    ...environmentLines,
    '  $process = New-Object System.Diagnostics.Process',
    '  $process.StartInfo = $startInfo',
    '  $stdout = [IO.File]::Open($stdoutPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)',
    '  $stderr = [IO.File]::Open($stderrPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)',
    '  try {',
    "    if (-not $process.Start()) { throw 'Myco process did not start' }",
    '    $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)',
    '    $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)',
    '    $process.WaitForExit()',
    '    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] @($stdoutCopy, $stderrCopy))',
    '    return $process.ExitCode',
    '  } finally {',
    '    $stdout.Dispose()',
    '    $stderr.Dispose()',
    '    $process.Dispose()',
    '  }',
    '}',
  ];

  if (!spec.keepAlive) {
    return [...preamble, '$exitCode = Invoke-MycoProcess', 'exit $exitCode', ''].join('\r\n');
  }

  const backoffSeconds = Math.max(1, spec.throttleSeconds || 2);
  return [
    ...preamble,
    '$restarts = 0',
    'while ($true) {',
    '  try {',
    '    $exitCode = Invoke-MycoProcess',
    '  } catch {',
    '    [Console]::Error.WriteLine($_.Exception.ToString())',
    '    $exitCode = 1',
    '  }',
    '  if ($exitCode -eq 0) { exit 0 }',
    '  $restarts += 1',
    '  if ($restarts -ge 10) { exit $exitCode }',
    `  Start-Sleep -Seconds ${backoffSeconds}`,
    '}',
    '',
  ].join('\r\n');
}
