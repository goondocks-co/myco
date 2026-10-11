import { askOnTerminal } from '../../../packages/myco/src/setup/prompt.js';

Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
try {
  const answer = askOnTerminal('Choose a project: ');
  process.stdout.write('READY\n');
  await answer;
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
