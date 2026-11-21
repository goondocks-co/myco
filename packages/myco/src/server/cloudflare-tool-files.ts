import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { valid } from 'semver';
import { TOOL_CHECK_TIMEOUT_MS, CLOUDFLARE_SETUP_COMMAND, readWranglerVersion } from './cloudflare-tool-version.js';
import type { CommandRunner } from './runner.js';
import { withCloudflareOperation } from './cloudflare-operation.js';

const RENAME_DELAYS_MS = [0, 100, 300, 1000] as const;
const STALE_TOOL_DIRECTORY = /^\.wrangler-(?:old-)?[A-Za-z0-9]{6}$/;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameTool(from: string, to: string): Promise<void> {
  for (const [attempt, wait] of RENAME_DELAYS_MS.entries()) {
    if (wait) await delay(wait);
    try { fs.renameSync(from, to); return; }
    catch (error) {
      if (attempt === RENAME_DELAYS_MS.length - 1 || !TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
}

/** Own versioned tool publication, repair rollback and stale installation directories. */
export class CloudflareToolFiles {
  readonly root: string;
  readonly directory: string;
  constructor(readonly home: string, readonly version: string) {
    if (valid(version) !== version) throw new Error('Wrangler tool version must be an exact semantic version');
    this.home = path.resolve(home);
    this.root = path.join(this.home, 'server', 'tools');
    this.directory = path.join(this.root, `wrangler-${version}`);
  }
  entry(directory = this.directory): string { return path.join(directory, 'node_modules', 'wrangler', 'bin', 'wrangler.js'); }
  versions(): string[] {
    const root = fs.lstatSync(this.root, { throwIfNoEntry: false });
    return root === undefined ? [] : fs.readdirSync(this.root).filter(name => name.startsWith('wrangler-') && valid(name.slice('wrangler-'.length)) !== null).sort();
  }
  unfinished(): string[] {
    return fs.existsSync(this.root) ? fs.readdirSync(this.root).filter(name => STALE_TOOL_DIRECTORY.test(name)).sort() : [];
  }
  install(options: { prepare: (directory: string) => Promise<void>; runner: CommandRunner; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<void> {
    return withCloudflareOperation(this.home, async () => {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const retired: { from: string; aside: string }[] = [];
      let stage: string | undefined;
      let published = false;
      try {
        for (const name of this.versions()) {
          const from = path.join(this.root, name);
          const aside = fs.mkdtempSync(path.join(this.root, '.wrangler-old-'));
          retired.push({ from, aside });
          await renameTool(from, path.join(aside, 'tool'));
        }
        stage = fs.mkdtempSync(path.join(this.root, '.wrangler-'));
        await options.prepare(stage);
        const entry = this.entry(stage);
        if (!fs.existsSync(entry)) throw new Error('Wrangler installation did not create its executable; run `myco setup --create cloudflare`.');
        const version = readWranglerVersion(await options.runner.run('node', [entry, '--version'], { cwd: stage, env: options.env, signal: options.signal, timeoutMs: TOOL_CHECK_TIMEOUT_MS }));
        if (version !== this.version) throw new Error(`Wrangler installation returned ${version}, expected ${this.version}. Run ${CLOUDFLARE_SETUP_COMMAND}.`);
        await renameTool(stage, this.directory);
        published = true;
        for (const name of this.unfinished()) {
          fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
        }
      } catch (error) {
        if (!published) {
          const restoration = await Promise.allSettled(retired.reverse().map(async (item) => {
            const tool = path.join(item.aside, 'tool');
            if (fs.existsSync(tool)) await renameTool(tool, item.from);
            fs.rmSync(item.aside, { recursive: true, force: true });
          }));
          const failures = restoration.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length) throw new AggregateError([error, ...failures], `Wrangler repair failed; prior tools remain in ${this.root}`);
        }
        throw error;
      } finally { if (stage !== undefined) fs.rmSync(stage, { recursive: true, force: true }); }
    });
  }
}
