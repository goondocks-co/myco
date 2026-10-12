import { spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';

const forbidden = (): never => {
  process.stderr.write('FORBIDDEN_PROCESS_SPAWN\n');
  process.exit(97);
};
spyOn(childProcess, 'spawn').mockImplementation(forbidden);
spyOn(childProcess, 'spawnSync').mockImplementation(forbidden);
spyOn(childProcess, 'execFile').mockImplementation(Object.assign(forbidden, { __promisify__: forbidden }));
spyOn(childProcess, 'execFileSync').mockImplementation(forbidden);
spyOn(Bun, 'spawn').mockImplementation(forbidden);
spyOn(Bun, 'spawnSync').mockImplementation(forbidden);
delete process.env.MYCO_NO_AUTO_SPAWN;
const command = process.argv[2] ?? 'mcp';
process.argv = [process.execPath, 'myco', command, ...(command === 'tool' ? ['list', '--json'] : [])];
if (command === 'mcp') await (await import('../../packages/myco/src/mcp/stdio-bridge.js')).main();
else await import('../../packages/myco/src/cli.js');
