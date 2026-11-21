import { BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';
import type { CommandRunner } from '@myco/server/runner.js';

/** Prerequisites for fixtures whose provider boundary scripts only operator-token reads. */
export function withWranglerPrerequisites(runner: CommandRunner): CommandRunner {
  return { run(command, args, options) {
    const stdout = command === 'node' && args[0] === '--version' ? 'v26.0.0'
      : args.includes('--version') ? BUNDLED_WORKER_WRANGLER : args.includes('whoami') ? '{"loggedIn":true}' : undefined;
    return stdout === undefined ? runner.run(command, args, options) : Promise.resolve({ code: 0, stdout, stderr: '' });
  } };
}

/** Local Node probes do not enter a fixture's provider command history. */
export function fakeWranglerRunner(runner: CommandRunner): CommandRunner {
  return { async run(command, args, options) {
    if (command === 'node' && args[0] === '--version') return { code: 0, stdout: 'v26.0.0', stderr: '' };
    const result = await runner.run(command, args, options);
    return args.includes('--version') && result.code === 0 && !result.stdout && !result.stderr
      ? { ...result, stdout: BUNDLED_WORKER_WRANGLER } : result;
  } };
}
