import fs from 'node:fs';
import path from 'node:path';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/cli/member-keep-current.js';
import { runProvision } from '@myco/cli/member.js';

const [mode, home, signal] = process.argv.slice(2);
if (!mode || !home || !signal) throw new Error('repair lease fixture needs mode, home and signal');
if (mode === 'hold') {
  const lease = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK), { command: 'fixture helper' });
  if (!lease.acquired) throw new Error('fixture helper could not acquire the lease');
  try {
    process.stdout.write('READY\n');
    while (!fs.existsSync(signal)) await Bun.sleep(10);
    await Bun.sleep(75);
  } finally { lease.lock.release(); }
} else if (mode === 'remove') {
  const acquire = LifecycleLock.acquire;
  LifecycleLock.acquire = (file, opts) => {
    if (opts?.command === 'myco member provision --remove') fs.writeFileSync(signal, JSON.stringify({ wait: opts.wait }));
    return acquire(file, opts);
  };
  if (!runProvision(['codex', '--remove'], { mycoHome: home, cwd: process.cwd() })) process.exitCode = 2;
} else throw new Error(`unknown repair lease fixture mode: ${mode}`);
