import fs from 'node:fs';
import { join } from 'node:path';
import { credentialFile, type Harness } from '../harnesses.js';
import { freshRunHome } from './run-home.js';

/** OpenCode's data, cache and state belong to this launch; its login remains the machine's. */
export function opencodeLaunchHome(scratchDir: string, harness: Harness): Record<string, string> {
  const home = freshRunHome(scratchDir, 'opencode-home');
  const data = join(home, 'data');
  const appData = join(data, 'opencode');
  fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
  const login = credentialFile(harness);
  if (login !== null && fs.existsSync(login)) fs.symlinkSync(login, join(appData, 'auth.json'));
  return { XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state') };
}
