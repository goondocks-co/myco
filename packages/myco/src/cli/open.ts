import { connectToDaemon } from './shared.js';
import { openBrowser } from './open-browser.js';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  const client = await connectToDaemon(vaultDir);

  const info = client.getInfo();
  if (!info) {
    console.error('Could not read daemon state. Try: myco restart');
    process.exit(1);
  }

  const url = `http://localhost:${info.port}/`;

  openBrowser(url);
  console.log(`Opened ${url}`);
}
