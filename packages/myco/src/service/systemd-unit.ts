import { resolveScope } from './types.js';
import type { ServiceSpec } from './types.js';

function shellEscape(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * systemd's default `LimitNOFILE` for user services is 1024 on most
 * distros — fine for a typical CLI tool, but the daemon serves HTTP +
 * N SQLite handles + log streams, and a burst of concurrent connections
 * can exhaust the cap. Raise it explicitly so the unit file is the
 * source of truth instead of inheriting whatever the distro chose. See
 * the matching `SoftResourceLimits.NumberOfFiles` in launchd-plist.ts.
 */
const SYSTEMD_LIMIT_NOFILE = 65_535;

export function renderSystemdUnit(spec: ServiceSpec): string {
  // systemd splits ExecStart on whitespace, so an unquoted executable or arg
  // under a spaced path (e.g. a user profile with a space) would be torn into
  // separate words. Per systemd's quoting rules a double-quoted token is one
  // argument, with C-style `\"`/`\\` escapes inside — which is exactly what
  // shellEscape emits. Quote every token so spaced paths survive intact.
  const execLine = [spec.executable, ...spec.args].map(shellEscape).join(' ');
  const envLines = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${shellEscape(`${k}=${v}`)}`)
    .join('\n');

  const restart = spec.keepAlive ? 'on-failure' : 'no';
  const scope = resolveScope(spec);
  // A system unit (boot+root) is wanted by the machine, not a user session.
  // Every other cell keeps today's exact bytes (§13.13 gate 1).
  const bootRoot = scope.startAt === 'boot' && scope.runAs === 'root';
  const wantedBy = spec.runAtLoad ? (bootRoot ? 'multi-user.target' : 'default.target') : '';
  const description = spec.description ?? `Myco daemon (${spec.variant})`;
  // `# X-Myco-Scope=` is a COMMENT, not a directive (spec m3): its only job
  // is making the rendered bytes differ across scopes so the content-match
  // early return in systemd.ts cannot swallow a scope change. Emitted only
  // for a DECLARED scope so undeclared specs stay byte-identical to today.
  const scopeMarker = spec.scope ? `# X-Myco-Scope=${scope.startAt}\n` : '';

  return `${scopeMarker}[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.workingDir}
${envLines}
ExecStart=${execLine}
StandardOutput=append:${spec.stdoutPath}
StandardError=append:${spec.stderrPath}
Restart=${restart}
RestartSec=${spec.throttleSeconds}
LimitNOFILE=${SYSTEMD_LIMIT_NOFILE}

[Install]
${wantedBy ? `WantedBy=${wantedBy}` : ''}
`;
}
