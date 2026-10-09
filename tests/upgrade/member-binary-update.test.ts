import { afterAll, beforeEach, afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { run } from '../../packages/myco/src/cli/upgrade.js';
import { writeInstallMarker } from '../../packages/myco/src/install/managed-binary.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-update-'));
let restoreHome: () => void;
beforeEach(() => { restoreHome = bindSandboxChildHome(root); });
afterEach(() => restoreHome());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('2.0 member binary update through the CLI', () => {
  for (const [custom, current] of [[false, '2.0.0-alpha.1'], [true, '2.0.0-alpha.1'], [false, '0.0.0-dev'], [false, '0.0.0-dev+fixture']] as const) it.skipIf(process.platform === 'win32')('places a verified binary, refreshes the membership, and starts no daemon', async () => {
    const home = path.join(root, `${custom ? 'custom-home' : 'home'}-${current}`);
    const binary = custom ? path.join(root, 'custom-bin/myco') : path.join(home, 'bin/myco');
    const source = path.join(root, 'binary');
    const c = path.join(root, 'binary.c');
    fs.writeFileSync(c, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("2.1.0-alpha.1"); return 0; }
  char file[4096]; snprintf(file, sizeof(file), "%s/refresh.log", getenv("MYCO_HOME"));
  FILE *out = fopen(file, "a"); if (!out) return 1;
  for (int i=1;i<argc;i++) fprintf(out, "%s%s", i>1 ? " " : "", argv[i]);
  fputs("\\n", out); fclose(out); return 0;
}`);
    const compiled = spawnSync('cc', ['-o', source, c], { encoding: 'utf8' });
    expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: '' });
    const asset = `myco-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
    const sum = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: binary });
    await run(['--channel', 'alpha'], {
      currentVersion: current, home, platform: process.platform, isMemberHome: () => true,
      resolveRefs: async channel => { expect(channel).toBe('alpha'); return {
        assetName: asset, assetUrl: 'binary', sha256sumsUrl: 'sums', targetVersion: '2.1.0-alpha.1',
      }; },
      stageDeps: {
        download: async (url, dest) => { if (url === 'binary') fs.copyFileSync(source, dest); else fs.writeFileSync(dest, `${sum}  ${asset}\n`); },
        computeSha256: async file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      },
      initiateAdopt: async () => { throw new Error('A member update must not start the daemon orchestrator'); },
    });
    expect(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.1.0-alpha.1');
    expect(fs.readFileSync(path.join(home, 'refresh.log'), 'utf8')).toBe('member provision --refresh\n');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8')).channel).toBe('alpha');
    expect(fs.readdirSync(home).sort()).toEqual(['bin', 'install.json', 'last-update-check.json', 'refresh.log']);
    if (custom) expect(fs.existsSync(path.join(home, 'bin/myco'))).toBe(false);
  });
  it('does not stage an older or out-of-channel explicit version', async () => {
    let staged = false;
    for (const target of ['2.0.0', '2.2.0-alpha.1', '2.2.0-rc.1']) {
      await run([target, '--channel', 'beta'], {
        home: root, currentVersion: '2.1.0-beta.1', targetTriple: () => 'darwin-arm64',
        fetchReleases: async () => [{ tag_name: `myco/v${target}`, prerelease: target.includes('-'), assets: [] }],
        stageBinary: async () => { staged = true; throw new Error('Ineligible update reached staging'); },
      });
    }
    expect(staged).toBe(false);
  });
});
