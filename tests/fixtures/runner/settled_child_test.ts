import { test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

test.skipIf(!process.env.MYCO_RUNNER_SETTLED_CHILD_FILE)('leaves an unrefed child after passing', async () => {
  const ready = process.env.MYCO_RUNNER_SETTLED_CHILD_FILE!;
  const child = spawn('node', ['-e', 'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', ready], { stdio: 'ignore' });
  child.unref();
  while (!fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));
});
