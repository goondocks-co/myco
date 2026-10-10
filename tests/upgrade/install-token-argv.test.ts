import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from '../support/fenced-fs.mjs';

import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

import { assertPrivate, assertTokenFree } from '../support/installer-token-gate.js';

const SHELLS = ['/bin/sh', '/bin/bash', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];
const FAKE_TOKEN = 'ghp_fake_installer_1644';
const BINARY = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.0.0; fi\nexit 0\n';
const CHECKSUM = createHash('sha256').update(BINARY).digest('hex');
const INSTALLER = resolve('docs/install.sh');

type CurlCall = { argv: string[]; config: string };

function install(shell: string, os: string, tokens: Record<string, string>, fail = false, trace = false) {
  const root = mkdtempSync(join(tmpdir(), 'myco-install-token-'));
  const home = join(root, 'home');
  const bin = join(root, 'tools');
  const temp = join(root, 'tmp');
  for (const dir of [home, bin, temp]) mkdirSync(dir);
  const log = join(root, 'curl.jsonl');
  const tool = (name: string, body: string) => writeFileSync(join(bin, name), body, { mode: 0o755 });
  tool('uname', `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo x86_64;; esac\n`);
  tool('mktemp', '#!/bin/sh\nif [ $# -eq 0 ]; then exec /usr/bin/mktemp "$TMPDIR/myco-installer-XXXXXX"; fi\nexec /usr/bin/mktemp "$@"\n');
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
  fs.writeFileSync(out, JSON.stringify([{ tag_name: 'myco/v2.0.0', prerelease: false, draft: false, assets: [{ name: 'myco-${os.toLowerCase()}-x64' }, { name: 'SHA256SUMS' }] }]));
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
    const result = spawnSync(shell, [...(trace ? ['-x'] : []), INSTALLER], {
      encoding: 'utf8', cwd: root,
      env: sandboxChildEnv(root, {
        HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
        MYCO_CHANNEL: 'stable', MYCO_HOME: join(home, '.myco'), MYCO_BIN_DIR: join(home, '.myco/bin'), TMPDIR: temp,
        PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: '', GH_TOKEN: '', ...tokens,
        CURL_LOG: log, FAIL_DOWNLOAD: fail ? '1' : '0',
      }),
      timeout: 15_000,
    });
    expect(result.error, 'installer must finish before its subprocess timeout').toBeUndefined();
    const secrets = Object.values(tokens).flatMap(token => [token, token.replaceAll('\\', '\\\\').replaceAll('"', '\\"')]);
    assertTokenFree(result.stdout + result.stderr, secrets);
    expect(result.status === (fail ? 22 : 0), 'installer exit status must match the scenario').toBe(true);
    const calls: CurlCall[] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { result, calls, tempFiles: readdirSync(temp) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('installer GitHub credentials stay out of spawned curl argv', () => {
  for (const shell of SHELLS) {
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
          expect(calls.length).toBe(3);
          assertPrivate(calls, token);
          expect(tempFiles).toEqual([]);
        });
      }
    }
  }

  for (const shell of SHELLS) {
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      it(`shell tracing stays credential-free and resumes afterwards: ${shell} ${name}`, () => {
        const { result, calls } = install(shell, 'Linux', { [name]: `${FAKE_TOKEN}\"\\` }, false, true);
        assertPrivate(calls, `${FAKE_TOKEN}\"\\`);
        expect(result.stderr.includes('+ chmod +x'), 'caller tracing must resume after credential handling').toBe(true);
      });
    }
  }

  it('preserves curl failures and leaves no credential files', () => {
    const { result, calls, tempFiles } = install('/bin/sh', 'Linux', { GH_TOKEN: FAKE_TOKEN }, true);
    expect(result.status).toBe(22);
    expect(calls.length).toBe(2);
    assertPrivate(calls, FAKE_TOKEN);
    expect(tempFiles).toEqual([]);
  });
});
