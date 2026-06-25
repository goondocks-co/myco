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

  const envEntries = Object.entries(spec.env)
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
${keepAlive}${resourceLimits}</dict>
</plist>
`;
}
