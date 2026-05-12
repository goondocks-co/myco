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

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const programArgs = [spec.executable, ...spec.args]
    .map((a) => `    ${tag('string', escapeXml(a))}`)
    .join('\n');

  const envEntries = Object.entries(spec.env)
    .map(([k, v]) => `    ${tag('key', escapeXml(k))}\n    ${tag('string', escapeXml(v))}`)
    .join('\n');

  const keepAlive = spec.keepAlive
    ? `  <key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>\n  ${tag('integer', String(spec.throttleSeconds))}\n`
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
${keepAlive}</dict>
</plist>
`;
}
