/**
 * A `.env` file in the directory a CLI process starts in: each `NAME=value` line it holds sets that variable for this
 * process, unless the environment already sets it.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}
