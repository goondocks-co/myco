import { connectToDaemon } from './shared.js';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  await connectToDaemon(vaultDir);

  const daemonPath = path.join(vaultDir, 'daemon.json');
  let port: number;
  try {
    const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
    port = info.port;
  } catch {
    console.error('Could not read daemon.json. Try: myco restart');
    process.exit(1);
  }

  const url = `http://localhost:${port}/`;

  // `start` on Windows is a cmd.exe builtin, not an executable — must use exec, not execFile
  const cmd = process.platform === 'darwin' ? `open ${url}`
    : process.platform === 'win32' ? `start ${url}`
    : `xdg-open ${url}`;

  exec(cmd);
  console.log(`Opened ${url}`);
}
