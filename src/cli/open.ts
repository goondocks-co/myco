import { connectToDaemon } from './shared.js';
import { openBrowser } from './open-browser.js';
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

  openBrowser(url);
  console.log(`Opened ${url}`);
}
