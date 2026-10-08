import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from '../support/fenced-fs.mjs';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { assertTokenFree } from '../support/installer-token-gate.js';

const FAKE_TOKEN = 'ghp_fake_installer_1644';
const SHELLS = ['/bin/sh', '/bin/bash', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];

function isolatedEnv(home: string) {
  return sandboxChildEnv(home, {
    HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    MYCO_HOME: join(home, '.myco'), NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', CURL_HOME: home, XDG_CONFIG_HOME: home,
    GITHUB_TOKEN: '', GH_TOKEN: '',
  });
}

function request(shell: string, script: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(shell, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(script);
  });
}

describe('installer credential logging protections', () => {
  it('real curl ignores inherited verbose and trace settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-install-curlrc-'));
    const home = join(root, 'home');
    mkdirSync(home);
    let requests = 0;
    let correctHeaders = true;
    const server = createServer((req, res) => {
      requests++;
      correctHeaders &&= req.headers.authorization === `Bearer ${FAKE_TOKEN}`;
      res.end('ok');
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback listener must have a port');
      const source = readFileSync(resolve('docs/install.sh'), 'utf8');
      const helpers = source.slice(source.indexOf('auth_token()'), source.indexOf('# Run'));
      const script = `set -eu\nREPO=goondocks-co/myco\nerror() { printf '%s\\n' "$1" >&2; }\n${helpers}\ngh_request -fsSL http://127.0.0.1:${address.port}/\n`;
      for (const shell of SHELLS) {
        for (const mode of ['verbose', 'trace']) {
          const trace = join(root, `${shell.split('/').at(-1)}-${mode}.trace`);
          writeFileSync(join(home, '.curlrc'), mode === 'verbose' ? 'verbose\n' : `verbose\ntrace-ascii = "${trace}"\n`);
          const result = await request(shell, script, { ...isolatedEnv(home), GITHUB_TOKEN: FAKE_TOKEN });
          assertTokenFree(result.stdout + result.stderr, [FAKE_TOKEN]);
          assertTokenFree(existsSync(trace) ? readFileSync(trace, 'utf8') : '', [FAKE_TOKEN]);
          expect(result.code === 0, 'real curl must complete the request').toBe(true);
          expect(existsSync(trace), 'implicit trace files must not be created').toBe(false);
        }
      }
      expect(requests).toBe(SHELLS.length * 2);
      expect(correctHeaders, 'loopback requests must retain authentication').toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('intentionally failing gates produce credential-free diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-install-gate-output-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const fixture = join(root, 'failing-gate.test.ts');
    writeFileSync(fixture, `import { it } from 'bun:test';
import { assertPrivate, assertTokenFree } from ${JSON.stringify(resolve('tests/support/installer-token-gate.ts'))};
const token = process.env.MYCO_FAKE_TOKEN!;
it('rejects argv leaks', () => assertPrivate([{ argv: ['-H', 'Authorization: Bearer ' + token], config: '' }], token));
it('rejects incorrect config', () => assertPrivate([{ argv: ['-q', '--config', '-', 'Accept: application/vnd.github+json', 'User-Agent: myco-installer/goondocks-co/myco'], config: token }], token));
it('rejects child output leaks', () => assertTokenFree(token, [token]));
`);
    try {
      const result = spawnSync('npm', ['test', '--', fixture], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 30_000,
        env: {
          ...isolatedEnv(home), MYCO_FAKE_TOKEN: FAKE_TOKEN, MYCO_RUNNER_REPORT_DIR: join(root, 'reports'),
          MYCO_TEST_KIND: 'all', MYCO_TEST_SHARD: '1/1', MYCO_TEST_PROFILE: '',
        },
      });
      expect((result.stdout + result.stderr).includes(FAKE_TOKEN), 'failing gate diagnostics must contain no credentials').toBe(false);
      expect(result.status === 1, 'all intentionally leaky gates must fail').toBe(true);
      expect((result.stdout + result.stderr).includes('3 fail'), 'each diagnostic path must be exercised').toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
