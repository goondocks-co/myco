import { run } from '@myco/cli/login.js';
import { run as setup } from '@myco/cli/setup.js';
import { run as member } from '@myco/cli/member.js';
import { run as logout } from '@myco/cli/logout.js';

const [operation, ...args] = process.argv.slice(2);
if (operation === 'setup') process.exitCode = await setup(args);
else if (operation === 'member') await member(args);
else if (operation === 'logout') { if (!await logout(args)) process.exitCode = 1; }
else if (!await run(args)) process.exitCode = 1;
console.log(`LOGIN_RETURNED:${JSON.stringify(process.getActiveResourcesInfo())}`);
