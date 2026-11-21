import { stripVTControlCharacters } from 'node:util';
import type { CommandResult } from './runner.js';

export const CLOUDFLARE_SETUP_COMMAND = 'myco setup --create cloudflare';
export const TOOL_CHECK_TIMEOUT_MS = 30_000;

export function wranglerVersionDiagnostic(result: CommandResult): string {
  const lines = stripVTControlCharacters(result.stderr.trim() || result.stdout.trim()).split('\n')
    .map(line => line.trim()).filter(line => line && !/^(?:npm notice|npm error A complete log|Consider using a Node.js version manager)/.test(line));
  return lines.slice(0, 3).join(' ') || `exit ${result.code}, no diagnostic output`;
}

export function readWranglerVersion(result: CommandResult): string {
  if (result.code !== 0) throw new Error(`Wrangler version check failed: ${wranglerVersionDiagnostic(result)}`);
  const version = /(\d+\.\d+\.\d+(?:-[\da-z.-]+)?)/i.exec(result.stdout + result.stderr)?.[1];
  if (version === undefined) throw new Error('Wrangler version check returned no version');
  return version;
}
