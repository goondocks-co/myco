import { connectToDaemon } from './shared.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  await connectToDaemon(vaultDir);

  const daemonPath = path.join(vaultDir, 'daemon.json');
  const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
  const url = `http://localhost:${info.port}/`;

  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';

  execFile(cmd, [url]);
  console.log(`Opened ${url}`);
}
