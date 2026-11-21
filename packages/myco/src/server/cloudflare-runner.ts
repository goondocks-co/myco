import { existsSync } from 'node:fs';
import path from 'node:path';
import { systemRunner, type CommandRunner } from './runner.js';

/** Windows npm launchers run their JavaScript entry with literal argv and no shell. */
export function cloudflareRunner(): CommandRunner {
  const runner = systemRunner();
  return { async run(command, args, options) {
    if (process.platform === 'win32' && (command === 'npm.cmd' || command === 'npx.cmd')) {
      const env = options?.env ?? process.env;
      const searchPath = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
      const directory = searchPath.split(path.delimiter).find(folder => existsSync(path.join(folder, command)));
      const script = directory === undefined ? undefined : path.join(directory, 'node_modules', 'npm', 'bin', `${command.slice(0, -4)}-cli.js`);
      if (script === undefined || !existsSync(script)) throw Object.assign(new Error(`${command} cannot find its npm CLI; reinstall Node.js from https://nodejs.org/en/download`), { code: 'ENOENT' });
      command = 'node';
      args = [script, ...args];
    }
    return runner.run(command, args, options);
  } };
}
