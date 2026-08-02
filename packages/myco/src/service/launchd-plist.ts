import os from 'node:os';
import { resolveScope } from './types.js';
import type { ServiceSpec } from './types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tag(name: string, value: string): string {
  return `<${name}>${value}</${name}>`;
}

/**
 * launchd inherits the user session's `maxfiles` limit (typically 256 on
 * macOS), which is far too low for a daemon serving HTTP plus N
 * SQLite handles plus log streams. A burst of ~250 concurrent connections
 * exhausted the fd table in dogfood and started returning EMFILE on
 * `accept()`. SoftResourceLimits / HardResourceLimits inside the plist
 * raise the daemon's per-process cap independent of whatever the user
 * session is configured for.
 */
const LAUNCHD_NUMBER_OF_FILES = 65_535;

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const programArgs = [spec.executable, ...spec.args]
    .map((a) => `    ${tag('string', escapeXml(a))}`)
    .join('\n');

  const scope = resolveScope(spec);
  const bootAsUser = scope.startAt === 'boot' && scope.runAs === 'invoking-user';
  // R-M4: a LaunchDaemon inherits NO user-session env. `machine-id` hashes
  // hostname+homedir through os.homedir() (which reads HOME), so an unset or
  // root HOME can mint a DIFFERENT machine_id for the same vault — a data
  // identity bug, not cosmetics. Also derived from HOME: the external-MCP
  // socket path and plan-capture paths. Rendered only for boot+invoking-user;
  // explicit spec.env values always win.
  const effectiveEnv = bootAsUser
    ? { HOME: os.homedir(), USER: os.userInfo().username, TMPDIR: os.tmpdir(), ...spec.env }
    : spec.env;
  const envEntries = Object.entries(effectiveEnv)
    .map(([k, v]) => `    ${tag('key', escapeXml(k))}\n    ${tag('string', escapeXml(v))}`)
    .join('\n');

  // Respawn ONLY on an unsuccessful exit (non-zero code or a signal), matching
  // systemd's `Restart=on-failure` and the Windows launcher's `errorlevel equ 0
  // -> stop`. A bare `<true/>` respawns even a deliberate step-aside `exit(0)`,
  // which hot-loops the job (~1/10s) when a sibling daemon holds the lock. With
  // `SuccessfulExit=false`, clean exits (step-aside, `daemon kill`, cooperative
  // shutdown) stay down while real crashes (non-zero) still restart.
  const keepAlive = spec.keepAlive
    ? `  <key>KeepAlive</key>\n`
      + `  <dict>\n`
      + `    <key>SuccessfulExit</key>\n`
      + `    <false/>\n`
      + `  </dict>\n`
      + `  <key>ThrottleInterval</key>\n  ${tag('integer', String(spec.throttleSeconds))}\n`
    : '';

  const resourceLimits =
    `  <key>SoftResourceLimits</key>\n` +
    `  <dict>\n` +
    `    <key>NumberOfFiles</key>\n` +
    `    ${tag('integer', String(LAUNCHD_NUMBER_OF_FILES))}\n` +
    `  </dict>\n` +
    `  <key>HardResourceLimits</key>\n` +
    `  <dict>\n` +
    `    <key>NumberOfFiles</key>\n` +
    `    ${tag('integer', String(LAUNCHD_NUMBER_OF_FILES))}\n` +
    `  </dict>\n`;

  // boot+invoking-user is a LaunchDaemon that DROPS to the installing user
  // (`UserName` is a LaunchDaemon-only key; §13.3's launchd row). No other
  // cell emits it, so undeclared specs render byte-identical to today.
  // There is NO clean launchd equivalent of systemd's `After=network.target`
  // (§13.12(b)) — boot-scoped consumers rely on the daemon's own reconnect
  // loops; the Stage E rig check owns proving that suffices.
  if (bootAsUser && process.getuid?.() === 0) {
    // N1: identity here comes from the INVOKING process. Rendered under
    // sudo, this would mint UserName=root / HOME=/var/root — a divergent
    // machine_id and root-owned files in the user's vault. The privileged
    // backend elevates per-step itself; the CLI must never run as root.
    throw new Error(
      'Refusing to render a boot+invoking-user service as root. '
      + 'Run `myco service install` WITHOUT sudo — Myco elevates only the individual steps that need it.',
    );
  }
  const userName = bootAsUser
    ? `  <key>UserName</key>\n  ${tag('string', escapeXml(os.userInfo().username))}\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${tag('string', escapeXml(spec.label))}
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  ${tag('string', escapeXml(spec.workingDir))}
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  ${tag('string', escapeXml(spec.stdoutPath))}
  <key>StandardErrorPath</key>
  ${tag('string', escapeXml(spec.stderrPath))}
  <key>RunAtLoad</key>
  ${spec.runAtLoad ? '<true/>' : '<false/>'}
${userName}${keepAlive}${resourceLimits}</dict>
</plist>
`;
}
