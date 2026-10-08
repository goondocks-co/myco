import { afterAll, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sandboxChildEnv, resolveTestTool } from '../../scripts/test-environment.mjs';
import { selectChannelRelease } from '../../packages/myco/scripts/release-policy.mjs';
import { resolveTargetTriple } from '../../packages/myco/src/upgrade/release-assets.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-decoder-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const script = path.resolve('docs/install.sh');
const definitions = fs.readFileSync(script, 'utf8').split('main "$@"')[0];
const asset = `myco-${resolveTargetTriple()}`;

function tools(name: string, jq: boolean): string {
  const bin = path.join(root, name);
  fs.mkdirSync(bin);
  for (const tool of ['awk', 'tr', 'sh', 'uname', 'mktemp', 'cat', 'rm', 'sed', 'sha256sum', 'shasum', ...(jq ? ['jq'] : [])]) {
    const found = resolveTestTool(tool);
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  return bin;
}

async function boundedInstaller(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('sh', [script, '--dry-run'], { env, detached: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const timeout = setTimeout(() => {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  }, 7000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { status, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

const modes = [false, true];
for (const jq of modes) {
  it(`decodes 213 releases over three real-sized pages within five seconds (${jq ? 'jq' : 'native awk'})`, async () => {
    const bin = tools(`perf-${jq}`, jq);
    const pages = [100, 100, 13].map((count, page) => Array.from({ length: count }, (_, n) => ({
      tag_name: 'myco/v1.4.8', prerelease: false, draft: false,
      body: 'Release notes: "quoted", \\ paths,\nUnicode λ. '.padEnd(page === 0 ? 14000 : 2000, 'x'),
      assets: [asset, 'SHA256SUMS'].map(name => ({ name, browser_download_url: `https://example.test/${name}` })),
      id: page * 100 + n,
    })));
    let bytes = 0;
    pages.forEach((page, i) => {
      const json = JSON.stringify(page);
      bytes += Buffer.byteLength(json);
      fs.writeFileSync(path.join(root, `page-${i + 1}.json`), json);
    });
    expect(bytes).toBeGreaterThan(1_600_000);
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
out=''; url=''
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -w|-H|--config|--proto|--tlsv1.2) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
page=1; case "$url" in *'&page='*) page="\${url##*page=}" ;; esac
cat '${root}/page-'"$page"'.json' > "$out"
printf 200
`, { mode: 0o755 });
    const home = path.join(root, `perf-home-${jq}`);
    fs.mkdirSync(home);
    const started = performance.now();
    const result = await boundedInstaller(sandboxChildEnv(root, { PATH: bin, HOME: home, MYCO_HOME: path.join(home, 'myco'), TMPDIR: root }));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain('myco/v1.4.8');
    expect(performance.now() - started).toBeLessThan(5000);
  }, 10_000);

  it(`keeps 300 deterministic mixed sets in agreement with JavaScript (${jq ? 'jq' : 'native awk'})`, () => {
    const bin = tools(`fuzz-${jq}`, jq);
    let seed = 1495;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const channels = ['alpha', 'beta', 'stable'] as const;
    const expected: string[] = [];
    let commands = definitions + `\nASSET='${asset}'\nRELEASES_FILE='${root}/fuzz.rows'\n`;
    for (let i = 0; i < 300; i++) {
      const releases = Array.from({ length: 1 + random(20) }, () => {
        const phase = ['', '-alpha.1', '-beta.10', '-rc.2', '-alpha.01', '-preview', '\ninvalid'][random(7)];
        const version = `${1 + random(4)}.${random(15)}.${random(10)}${phase}`;
        return { body: 'ignored "quotes" \\ Unicode λ\n'.repeat(random(20)),
          assets: random(4) === 0 ? [] : [asset, 'SHA256SUMS'].map(name => ({ name, browser_download_url: '' })),
          draft: random(9) === 0, prerelease: phase !== '' || random(7) === 0,
          tag_name: `${random(8) === 0 ? 'myco-shared/v' : 'myco/v'}${version}` };
      });
      const file = path.join(root, `fuzz-${i}.json`);
      let json = JSON.stringify(releases);
      if (i % 3 === 0) json = json.replaceAll('"tag_name"', '"tag\\u005fname"').replaceAll('myco/v', 'myco\\/v');
      fs.writeFileSync(file, json);
      commands += `PAGE_FILE='${file}'\nrelease_rows > "$RELEASES_FILE"\nPAGE_FILE='${root}/does-not-exist'\n`;
      for (const channel of channels) {
        expected.push(selectChannelRelease(releases, channel, { asset })?.tag_name ?? 'none');
        commands += `tag="$(pick_tag ${channel} '')"\nprintf '%s\\n' "\${tag:-none}"\n`;
      }
    }
    const result = spawnSync('/bin/sh', [], { input: commands, env: sandboxChildEnv(root, { PATH: bin }), encoding: 'utf8', timeout: 45_000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout.trim().split('\n')).toEqual(expected);
  }, 60_000);
}

for (const jq of modes) it(`refuses malformed pages before selecting a cached partial list (${jq ? 'jq' : 'native awk'})`, () => {
  const bin = tools(`malformed-${jq}`, jq);
  for (const input of ['[{"tag_name":"myco/v2.0.0",}', '[{"tag_name":"unterminated]', '{}', '[1]', '[null]', '', '[] []']) {
    const file = path.join(root, 'bad.json');
    fs.writeFileSync(file, input);
    const result = spawnSync('/bin/sh', [], { input: definitions + `\nASSET='${asset}'\nPAGE_FILE='${file}'\nrelease_rows\n`, env: sandboxChildEnv(root, { PATH: bin }), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  }
});
