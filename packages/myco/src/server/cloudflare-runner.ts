import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { systemRunner, type CommandRunner } from './runner.js';
import { OPERATOR_WRANGLER_PROBE } from './cloudflare-operator-probe.js';

const operatorEntries = new WeakMap<CommandRunner, () => string | null | undefined>();
export function operatorWranglerEntry(runner: CommandRunner): string | undefined { return operatorEntries.get(runner)?.() ?? undefined; }

function executableDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const search = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  return search.split(platform === 'win32' ? ';' : path.delimiter);
}

function npmEntry(command: 'npm' | 'npx', env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { node: string; entry: string } | null {
  const directories = executableDirectories(env, platform);
  const node = directories.map(folder => path.join(folder, platform === 'win32' ? 'node.exe' : 'node')).find(file => existsSync(file));
  const launcher = directories.map(folder => path.join(folder, platform === 'win32' ? `${command}.cmd` : command)).find(file => existsSync(file));
  const besideLauncher = launcher === undefined ? undefined : realpathSync(launcher);
  const candidates = [
    ...(besideLauncher?.endsWith('-cli.js') ? [besideLauncher] : []),
    ...[launcher === undefined ? undefined : path.dirname(launcher), node === undefined ? undefined : path.dirname(node)]
      .filter((folder): folder is string => folder !== undefined)
      .map(folder => path.join(folder, 'node_modules', 'npm', 'bin', `${command}-cli.js`)),
  ];
  const entry = candidates.find(file => existsSync(file));
  return entry === undefined ? null : { node: node ?? 'node', entry };
}

/** Operator tool discovery and Windows npm launchers run through Node with literal argv. */
export function cloudflareRunner(options: { platform?: NodeJS.Platform; runner?: CommandRunner } = {}): CommandRunner {
  const runner = options.runner ?? systemRunner();
  const platform = options.platform ?? process.platform;
  let operator: string | null | undefined;
  const adapted: CommandRunner = { async run(command, args, runOptions) {
    const env = runOptions?.env ?? process.env;
    if ((command === 'npx' || command === 'npx.cmd') && args[0] === '--no-install' && args[1] === 'wrangler') {
      if (operator === undefined) {
        const npm = npmEntry('npm', env, platform);
        const found = await runner.run(npm?.node ?? 'node', ['--input-type=module', '-e', OPERATOR_WRANGLER_PROBE, runOptions?.cwd ?? process.cwd(), npm?.entry ?? ''], runOptions);
        if (found.code !== 0) return found;
        let parsed: unknown;
        try { parsed = JSON.parse(found.stdout); } catch { throw new Error('Operator Wrangler discovery returned unreadable JSON'); }
        if (parsed === null || typeof parsed !== 'object' || !('entry' in parsed) || (parsed.entry !== null && typeof parsed.entry !== 'string')) throw new Error('Operator Wrangler discovery returned no executable fact');
        operator = parsed.entry;
      }
      return operator === null ? { code: 1, stdout: '', stderr: 'Wrangler is not installed in local or global npm packages' }
        : runner.run('node', [operator, ...args.slice(2)], runOptions);
    }
    if (platform === 'win32' && (command === 'npm.cmd' || command === 'npx.cmd')) {
      const npm = npmEntry(command === 'npm.cmd' ? 'npm' : 'npx', env, platform);
      if (npm === null) throw Object.assign(new Error(`${command} cannot find its npm CLI beside its launcher or Node; reinstall Node.js from https://nodejs.org/en/download`), { code: 'ENOENT' });
      command = npm.node; args = [npm.entry, ...args];
    }
    return runner.run(command, args, runOptions);
  } };
  operatorEntries.set(adapted, () => operator);
  return adapted;
}
