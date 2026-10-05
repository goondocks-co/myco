import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from '../support/fenced-fs.mjs';

const FAKE_TOKEN = 'ghp_fake_installer_1644';
const BINARY = '#!/bin/sh\nexit 0\n';
const CHECKSUM = createHash('sha256').update(BINARY).digest('hex');
const INSTALLER = resolve('docs/install.sh');

type CurlCall = { argv: string[]; config: string };

function install(shell: string, os: string, tokens: Record<string, string>, fail = false) {
  const root = mkdtempSync(join(tmpdir(), 'myco-install-token-'));
  const home = join(root, 'home');
  const bin = join(root, 'tools');
  const temp = join(root, 'tmp');
  for (const dir of [home, bin, temp]) mkdirSync(dir);
  const log = join(root, 'curl.jsonl');
  const tool = (name: string, body: string) => writeFileSync(join(bin, name), body, { mode: 0o755 });
  tool('uname', `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo x86_64;; esac\n`);
  tool('mktemp', '#!/bin/sh\nif [ $# -eq 0 ]; then exec /usr/bin/mktemp "$TMPDIR/myco-installer-XXXXXX"; fi\nexec /usr/bin/mktemp "$@"\n');
  tool('jq', '#!/bin/sh\necho myco/v2.0.0\n');
  tool('codesign', '#!/bin/sh\nexit 0\n');
  tool('xattr', '#!/bin/sh\nexit 0\n');
  tool('sha256sum', `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex'));
`);
  tool('curl', `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const config = argv.includes('--config') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify({ argv, config }) + '\\n');
const out = argv[argv.indexOf('-o') + 1];
if (argv.includes('-w')) {
  fs.writeFileSync(out, '[]');
  process.stdout.write('200');
} else if (process.env.FAIL_DOWNLOAD === '1') {
  process.exit(22);
} else {
  fs.writeFileSync(out, argv.some(a => a.endsWith('/SHA256SUMS'))
    ? ${JSON.stringify(`${CHECKSUM}  myco-${os.toLowerCase()}-x64\n`)}
    : ${JSON.stringify(BINARY)});
}
`);
  try {
    const result = spawnSync(shell, [INSTALLER], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
        MYCO_CHANNEL: 'stable', MYCO_HOME: join(home, '.myco'), MYCO_BIN_DIR: join(home, '.myco/bin'), TMPDIR: temp,
        PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: '', GH_TOKEN: '', ...tokens,
        CURL_LOG: log, FAIL_DOWNLOAD: fail ? '1' : '0',
      },
      timeout: 15_000,
    });
    if (result.status !== (fail ? 22 : 0)) throw new Error(`Installer failed: ${result.status}: ${result.stderr} ${result.stdout}`);
    const calls: CurlCall[] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { result, calls, tempFiles: readdirSync(temp) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPrivate(calls: CurlCall[], token: string) {
  for (const call of calls) {
    expect(call.argv.join('\n')).not.toContain(FAKE_TOKEN);
    expect(call.argv).toContain('--config');
    expect(call.argv[call.argv.indexOf('--config') + 1]).toBe('-');
    expect(call.argv).toContain('Accept: application/vnd.github+json');
    expect(call.argv).toContain('User-Agent: myco-installer/goondocks-co/myco');
    const escaped = token.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    expect(call.config).toBe(token ? `header = "Authorization: Bearer ${escaped}"\n` : '');
  }
}

describe('installer GitHub credentials stay out of spawned curl argv', () => {
  for (const shell of ['/bin/sh', '/bin/bash', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])]) {
    for (const os of ['Darwin', 'Linux']) {
      for (const [name, tokens, token] of [
        ['no token', {}, ''],
        ['GITHUB_TOKEN', { GITHUB_TOKEN: FAKE_TOKEN }, FAKE_TOKEN],
        ['GH_TOKEN', { GH_TOKEN: FAKE_TOKEN }, FAKE_TOKEN],
        ['config escaping', { GH_TOKEN: `${FAKE_TOKEN}\"\\` }, `${FAKE_TOKEN}\"\\`],
        ['precedence', { GITHUB_TOKEN: FAKE_TOKEN, GH_TOKEN: 'ghp_unused' }, FAKE_TOKEN],
      ] as const) {
        it(`${shell} ${os}: ${name}`, () => {
          const { result, calls, tempFiles } = install(shell, os, tokens);
          expect(result.status).toBe(0);
          expect(calls).toHaveLength(3);
          assertPrivate(calls, token);
          expect(tempFiles).toEqual([]);
        });
      }
    }
  }

  it('preserves curl failures and leaves no credential files', () => {
    const { result, calls, tempFiles } = install('/bin/sh', 'Linux', { GH_TOKEN: FAKE_TOKEN }, true);
    expect(result.status).toBe(22);
    expect(calls).toHaveLength(2);
    assertPrivate(calls, FAKE_TOKEN);
    expect(tempFiles).toEqual([]);
  });
});
