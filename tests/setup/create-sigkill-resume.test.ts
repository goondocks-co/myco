import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { peekDeploymentRecord } from '@myco/server/cloudflare.js';
import { peekLocalPaths, readLocalSecrets } from '@myco/server/local.js';
import { readDeploymentMembership, readRegistryEntry } from '@myco/member/registry.js';
import { HOSTED_URL } from './fixtures/owner-deployment.js';

let root: string;
let project: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-create-interruption-'));
  project = path.join(root, 'repo');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('create journeys across SIGKILL', () => {
  const repo = fileURLToPath(new globalThis.URL('../../', import.meta.url));
  for (const target of ['cloudflare', 'local']) for (const boundary of ['create', 'conversion', 'signin', 'owner-mint', 'owner-link', 'machine', 'project', ...(target === 'cloudflare' ? ['cloudflare-login', 'partial-create', 'before-deploy', 'installed'] : ['service'])]) {
    it(`${target}: resumes after SIGKILL at ${boundary}`, async () => {
      const childRoot = path.join(root, 'child');
      fs.mkdirSync(childRoot);
      fs.renameSync(project, path.join(childRoot, 'repo'));
      const args = ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'), '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/create_journey_interruption_test.ts')];
      const env = sandboxChildEnv(childRoot, { MYCO_SETUP_FIXTURE_ROOT: childRoot, MYCO_SETUP_TARGET: target });
      const child = spawn(process.execPath, args, { env: { ...env, MYCO_SETUP_STOP_AFTER: boundary }, cwd: childRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const capture = (chunk: Buffer) => { output += chunk.toString(); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(path.join(childRoot, 'reached')) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        expect({ reached: fs.existsSync(path.join(childRoot, 'reached')), output: output.replace(/\/link#[^\s]+/g, '/link#[redacted]') }).toMatchObject({ reached: true });
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
      const childHome = path.join(childRoot, 'myco');
      const keys = target === 'local' ? readLocalSecrets(peekLocalPaths(childHome)) : null;
      const record = peekDeploymentRecord(childHome);
      const result = Bun.spawnSync([process.execPath, ...args], { env: { ...env, MYCO_SETUP_RESUME: '1' }, cwd: childRoot, stdout: 'pipe', stderr: 'pipe' });
      expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
      const resumed = JSON.parse(fs.readFileSync(path.join(childRoot, 'resumed'), 'utf8'));
      expect(resumed.commands.filter((command: string) => command.startsWith('d1 create'))).toHaveLength(boundary === 'cloudflare-login' ? 1 : 0);
      expect(resumed.conversions).toBe(['create', 'cloudflare-login', 'partial-create', 'before-deploy'].includes(boundary) ? 1 : 0);
      if (target === 'cloudflare') {
        expect(resumed.totalConversions).toBe(1);
        expect(peekDeploymentRecord(childHome)).toMatchObject({ versionId: expect.any(String), url: HOSTED_URL });
        expect(resumed.commands.filter((command: string) => command.startsWith('deploy '))).toHaveLength(['cloudflare-login', 'partial-create', 'before-deploy'].includes(boundary) ? 1 : 0);
        expect(fs.existsSync(path.join(childHome, 'server/cloudflare/sign-in-pending.json'))).toBe(false);
      }
      const address = target === 'cloudflare' ? HOSTED_URL : 'http://127.0.0.1:8787';
      expect(readDeploymentMembership(address, childHome)).not.toBeNull();
      expect(readRegistryEntry(path.join(childRoot, 'repo'), childHome)).not.toBeNull();
      if (target === 'cloudflare') {
        if (record) expect(peekDeploymentRecord(childHome)?.databaseId).toBe(record.databaseId);
        else expect(peekDeploymentRecord(childHome)?.databaseId).toBeTruthy();
      }
      else for (const key of ['SESSION_SECRET', 'SECRET_WRAP_KEY'] as const) expect(readLocalSecrets(peekLocalPaths(childHome))[key]).toBe(keys![key]);
    }, 30_000);
  }
});

