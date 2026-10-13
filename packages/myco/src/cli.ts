#!/usr/bin/env node
import { isHelpRequest } from './cli/flags.js';
import { loadEnv } from './cli/env-file.js';
import { keepLoopbackOffProxy } from './cli/loopback-proxy.js';
import { isRetiredVerb, retiredVerbMessage } from './cli/retired-verbs.js';

import { COMMANDS, helpForCommand } from './cli/command-registry.js';

loadEnv();

async function main(): Promise<void> {
  keepLoopbackOffProxy();
  const [cmd = '--help', ...args] = process.argv.slice(2);
  if (isRetiredVerb(cmd)) {
    console.error(await retiredVerbMessage(cmd));
    process.exitCode = 1;
    return;
  }
  if (isHelpRequest(args)) {
    process.stdout.write(await helpForCommand(cmd));
    return;
  }
  const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (command) return command.run(args);
  console.error(`Unknown command: ${cmd}`);
  process.stdout.write((await import('./cli/help.js')).helpText());
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`myco: ${(err as Error).message}`);
  process.exitCode = 1;
});
