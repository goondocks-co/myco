import type { ServiceSpec } from './types.js';

function shellEscape(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const execLine = [spec.executable, ...spec.args].join(' ');
  const envLines = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${shellEscape(`${k}=${v}`)}`)
    .join('\n');

  const restart = spec.keepAlive ? 'on-failure' : 'no';
  const wantedBy = spec.runAtLoad ? 'default.target' : '';

  return `[Unit]
Description=Myco daemon (${spec.variant})
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

[Install]
${wantedBy ? `WantedBy=${wantedBy}` : ''}
`;
}
