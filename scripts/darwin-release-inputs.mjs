import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @param {string} eventName @param {string[]} paths */
export function requiresDarwinRecipe(eventName, paths) {
  if (eventName === 'push') return true;
  if (eventName !== 'pull_request') throw new Error(`Unexpected CI event: ${eventName}`);
  return paths.some((name) => /^(?:\.github\/(?:workflows|actions)\/|scripts\/|packages\/myco\/scripts\/|\.bun-version$)/.test(name)
    || /(?:^|\/)package(?:-lock)?\.json$/.test(name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  let paths = [];
  if (eventName === 'pull_request') {
    const base = process.env.BASE_SHA ?? '';
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing or invalid PR base SHA');
    paths = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0');
  }
  const required = requiresDarwinRecipe(eventName, paths);
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub output path');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\n`);
}
