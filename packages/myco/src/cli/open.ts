import { openBrowser } from './open-browser.js';
import { resolveGlobalDaemonPort } from '../daemon/service-state.js';
import { probeMycoDaemon } from '../daemon/eviction.js';

export async function run(_args: string[]): Promise<void> {
  const port = resolveGlobalDaemonPort();

  if (!(await probeMycoDaemon(port))) {
    console.error(
      `No Myco daemon is answering on port ${port}. Install the platform service with: myco service install`,
    );
    process.exit(1);
  }

  const url = `http://localhost:${port}/`;
  openBrowser(url);
  console.log(`Opened ${url}`);
}
