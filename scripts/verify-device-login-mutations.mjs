import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const output = process.argv[2];
const parity = process.argv.includes('--parity');
if (!output || !process.env.HOME || !process.env.MYCO_HOME || !process.env.CODEX_HOME || !process.env.CLAUDE_CONFIG_DIR) throw new Error('Supply an owned evidence directory and an isolated harness home');
fs.mkdirSync(output, { recursive: true });
const device = 'packages/myco-server/src/auth/device.ts';
const auth = 'packages/myco-server/src/auth/authorization.ts';
const join = 'packages/myco-server/src/auth/join.ts';
const cli = 'packages/myco/src/cli/device-login.ts';
const url = 'packages/myco/src/member/server-url.ts';
const mutations = [
  ['digest-only', [[device, 'await sha256Hex(deviceCode)', 'deviceCode']]],
  ['pending', [[device, "if (row.decision !== 'approved') return deviceError('authorization_pending');", '']]],
  ['redemption', [[device, 'row === null || row.used_at !== null', 'row === null']]],
  ['denial', [[device, "if (row.decision === 'denied') return deviceError('access_denied');", '']]],
  ['expiry', [[device, "if (row.expires_at <= now) return deviceError('expired_token');", ''], [device, 'WHERE device_hash = ? AND expires_at > ?', 'WHERE device_hash = ? AND ? IS NOT NULL']]],
  ['slow-down', [[device, "if (pacing.slowed === 1) return deviceError('slow_down', 400, pacing.interval_seconds);", '']]],
  ['owner-admission', [[auth, "if (resource.kind === 'enrollment' && (resource.grantedRole === 'owner' || resource.grantedRole === 'admin') && subject.role !== 'owner') return false;", '']]],
  ['live-owner-cap', [[auth, "${alias}.role = 'member' AND NOT EXISTS", '1=1 OR NOT EXISTS']]],
  ['machine-binding', [[join, '(machine_id <> ? OR decision IS NOT', '(? IS NULL OR decision IS NOT']]],
  ['terminal-secret', [[cli, 'Code: ${userCode}', 'Code: ${deviceCode}']]],
  ...parity ? [] : [
    ['https-default', [[url, '`https://${address}`', '`http://${address}`']]],
    ['transport-rule', [[url, 'if (url.protocol !== \'http:\' || !isLoopbackHost(url.hostname)) return false;', 'if (url.protocol !== \'http:\') return false;']]],
  ],
];
const originals = new Map(mutations.flatMap(([, patches]) => patches.map(([file]) => [file, fs.readFileSync(path.join(root, file), 'utf8')])));
const restore = () => { for (const [file, source] of originals) fs.writeFileSync(path.join(root, file), source); };
const results = [];
try {
  for (const [name, patches] of mutations) {
    restore();
    for (const [file, from, to] of patches) {
      const absolute = path.join(root, file);
      const text = fs.readFileSync(absolute, 'utf8');
      if (text.split(from).length !== 2) throw new Error(`${name}: mutation anchor must occur once`);
      fs.writeFileSync(absolute, text.replace(from, to));
    }
    const args = parity ? ['test', '--', 'tests/parity/parity.test.ts', '-t', 'device login:']
      : ['test', '--', 'tests/myco-server/device.test.ts', 'tests/cli/device-login.test.ts'];
    const log = path.join(output, `${name}.log`);
    const fd = fs.openSync(log, 'w');
    let run;
    try { run = spawnSync('npm', args, { cwd: root, env: { ...process.env, ...(parity ? { MYCO_PARITY: '1' } : {}) }, stdio: ['ignore', fd, fd], timeout: 300000 }); }
    finally { fs.closeSync(fd); }
    const recorded = fs.readFileSync(log, 'utf8');
    const assertions = [...recorded.matchAll(/^\(fail\) (.+)$/gm)].map(match => match[1]);
    const killed = run.status !== 0 && assertions.length > 0 && /error:.*(?:expect|with no ledger)/.test(recorded);
    const nativeKilled = !parity || assertions.some(line => line.includes('[selfhosted]'));
    const workerdKilled = !parity || assertions.some(line => line.includes('[cloudflare]'));
    const result = { name, status: killed && nativeKilled && workerdKilled ? 'killed' : 'unproven', native: nativeKilled, workerd: parity ? workerdKilled : undefined, log };
    results.push(result);
    console.log(JSON.stringify(result));
    if (result.status !== 'killed') process.exitCode = 1;
  }
} finally {
  restore();
  fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
