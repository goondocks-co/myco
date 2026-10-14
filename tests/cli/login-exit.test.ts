import { expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from '../myco-server/helpers/owner.js';
import { sessionStartEvent } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { REGISTRY_VERSION, writeRegistryEntry, withRegistryLock, logoutBindings, removeDeploymentForLogout, membershipTokenDigest, readDeploymentMembership } from '@myco/member/registry.js';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const EXIT_WINDOW_MS = 5_000;

for (const [operation, tty, stalled] of [['login', false, true], ['login', true, true], ['setup', false, true], ['login', false, false], ['invite', false, true], ['setup-new', false, true]] as const) {
  it.skipIf(tty && process.platform === 'win32')(`${operation} exits after its capture summary with ${stalled ? 'stalled' : 'responsive'} backlog (${tty ? 'TTY' : 'pipe'})`, async () => {
    const isSetup = operation.startsWith('setup');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-login-exit-'));
    const env = sandboxChildEnv(home);
    for (const dir of [env.CODEX_HOME!, env.CLAUDE_CONFIG_DIR!, path.join(home, '.codeium/windsurf')]) fs.mkdirSync(dir, { recursive: true });
    const e = sqliteEnv();
    e.sqlite.run("UPDATE members SET role = 'admin', github_id = '770001' WHERE id = 'mem_machine_2'");
    const deployment = createServer({ now: Date.now, sourceOf: () => '192.0.2.10', fetchImpl: () => { throw new Error('unexpected outbound request'); } });
    let events = 0;
    let importPlans = 0;
    let revokeMissing = false;
    let foreignRequests = 0;
    const local = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/members/credential/revoke' && revokeMissing) return new Response('<html>Not Found</html>', { status: 404 });
      if (url.pathname === '/events') {
        events++;
        if (stalled && operation !== 'invite') return new Promise<Response>(() => {});
      }
      if (url.pathname === '/import/plan') {
        importPlans++;
        if (operation === 'invite' || operation === 'setup-new') return new Promise<Response>(() => {});
      }
      const serverEnv = { ...e.serverEnv, secrets: OWNER_ENV };
      const response = await deployment.handleRequest(request, serverEnv);
      if (url.pathname === '/auth/device/start' && response.ok) {
        const grant = await response.clone().json() as { user_code: string };
        const approved = await deployment.handleRequest(new Request(`${url.origin}/api/device/approve`, {
          method: 'POST', headers: { origin: url.origin, cookie: await ownerCookie(e.db, Date.now(), '770001') },
          body: JSON.stringify({ user_code: grant.user_code }),
        }), serverEnv);
        if (!approved.ok) throw new Error(`fake device approval failed: ${approved.status}`);
      }
      return response;
    } });
    const serverUrl = `http://127.0.0.1:${local.port}`;
    const root = path.join(home, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    const entry = { version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl, token: 'old-fixture-credential', root, machineId: 'machine_fixture',
      joinedAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 7 * 86400_000 };
    if (operation !== 'setup-new') writeRegistryEntry(entry, { mycoHome: env.MYCO_HOME });
    const spool = new MemberSpool(entry, { mycoHome: env.MYCO_HOME });
    if (operation !== 'setup-new') spool.append('waiting', sessionStartEvent({ agent: 'claude-code', sessionId: 'waiting', stage: spool.stagerFor('waiting') }, { originPath: root, startedAt: Date.now() }));
    const foreign = isSetup ? Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
      foreignRequests++;
      return new Response('Another Deployment', { status: 503 });
    } }) : null;
    let foreignSpool: MemberSpool | undefined;
    if (foreign !== null) {
      const other = { ...entry, serverUrl: `http://127.0.0.1:${foreign.port}`, projectId: 'proj_foreign', root: path.join(home, 'foreign'), token: 'foreign-fixture-credential' };
      fs.mkdirSync(other.root);
      writeRegistryEntry(other, { mycoHome: env.MYCO_HOME });
      foreignSpool = new MemberSpool(other, { mycoHome: env.MYCO_HOME });
      foreignSpool.append('foreign', sessionStartEvent({ agent: 'claude-code', sessionId: 'foreign', stage: foreignSpool.stagerFor('foreign') }, { originPath: other.root }));
      withRegistryLock(() => removeDeploymentForLogout(other.serverUrl,
        membershipTokenDigest(readDeploymentMembership(other.serverUrl, env.MYCO_HOME!)!),
        logoutBindings(env.MYCO_HOME!).filter(binding => binding.serverUrl === other.serverUrl), env.MYCO_HOME!), env.MYCO_HOME);

    }
    let address = serverUrl;
    let transcript: string | undefined;
    const history = `${JSON.stringify({ type: 'user', cwd: root, message: { content: 'past session' } })}\n`;
    if (operation === 'invite') {
      const invitation = await issueEnrollmentAuthority(e.db, Date.now(), { issuer: { kind: 'operator' }, role: 'member', projectId: 'proj_1' });
      address = `${serverUrl}/join#${invitation.key}`;
    }
    if (operation !== 'setup') {
      const directory = path.join(env.CLAUDE_CONFIG_DIR!, 'projects', `-${rootSlug(root)}`);
      fs.mkdirSync(directory, { recursive: true });
      transcript = path.join(directory, '00000000-0000-4000-8000-000000000001.jsonl');
      fs.writeFileSync(transcript, history);
      const old = new Date(Date.now() - 3600_000);
      fs.utimesSync(transcript, old, old);
    }

    const binary = process.env.MYCO_LOGIN_TEST_BINARY;
    const args = !isSetup ? ['login', address, ...(operation === 'invite' ? ['--root', root] : [])] : ['setup', '--join', serverUrl, '--root', root, '--project', 'proj_1', '--no-agents', '--no-runner', '--no-cutover', '--yes'];
    const command = binary ? [binary, ...args] : [process.execPath, '--tsconfig-override', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'tests/cli/fixtures/login-exit.ts'), ...args];
    const invocation = !tty ? command : ['python3', path.join(REPO, 'tests/cli/fixtures/terminal-process.py'), ...command];
    const child = spawn(invocation[0]!, invocation.slice(1), { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let summaryAt: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (summaryAt === undefined && output.includes(operation === 'setup-new' ? `Connected ${root}` : !isSetup ? 'Skipped Windsurf:' : 'Checking waiting capture')) {
        summaryAt = Date.now();
        clearTimeout(timer);
        timer = setTimeout(() => child.kill(tty ? 'SIGTERM' : 'SIGKILL'), operation !== 'setup' ? (stalled ? EXIT_WINDOW_MS : 2_000) : 8_000);
      }
    };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    timer = setTimeout(() => child.kill(tty ? 'SIGTERM' : 'SIGKILL'), 15_000);
    try {
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      expect(output).toContain('Signed in to');
      if (!isSetup) expect(output).toContain('Capture is set up for Claude Code, Codex.');
      expect(summaryAt).toBeDefined();
      expect(foreignRequests).toBe(0);
      if (foreignSpool !== undefined) expect(foreignSpool.readRecords('foreign')).toHaveLength(1);
      expect(events).toBe(operation === 'setup-new' ? 0 : operation === 'setup' ? 2 : 1);
      expect(status, output).toEqual({ code: 0, signal: null });
      expect(Date.now() - summaryAt!).toBeLessThan(operation !== 'setup' ? (stalled ? EXIT_WINDOW_MS : 2_000) : 8_000);
      if (!binary) expect(output).toContain('LOGIN_RETURNED:[]');
      expect(spool.readRecords('waiting')).toHaveLength(stalled && operation !== 'invite' && operation !== 'setup-new' ? 1 : 0);
      if (!stalled || operation === 'invite') expect(output).toContain('Delivered 1 session(s)');
      if (transcript !== undefined) {
        expect(importPlans).toBe(operation === 'invite' || operation === 'setup-new' ? 1 : 0);
        if (operation === 'invite' || operation === 'setup-new') {
          expect(output).toContain('Past sessions are still waiting');
          expect(output).toContain('myco import');
        }
        expect(fs.readFileSync(transcript, 'utf8')).toBe(history);
      }
      if (operation === 'login' && !tty && stalled) {
        for (const args of [['member', 'provision', '--refresh'], ['logout', serverUrl], ['logout', serverUrl, '--local-only']]) {
          revokeMissing = args[0] === 'logout';
          const next = binary ? [binary, ...args] : [process.execPath, '--tsconfig-override', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'tests/cli/fixtures/login-exit.ts'), ...args];
          const commandProcess = spawn(next[0]!, next.slice(1), { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
          let text = '';
          commandProcess.stdout!.on('data', chunk => { text += chunk.toString(); });
          commandProcess.stderr!.on('data', chunk => { text += chunk.toString(); });
          const stop = setTimeout(() => commandProcess.kill('SIGKILL'), EXIT_WINDOW_MS);
          try {
            const exit = await new Promise<number | null>((resolve, reject) => {
              commandProcess.once('error', reject);
              commandProcess.once('close', resolve);
            });
            const refusal = args[0] === 'logout' && !args.includes('--local-only');
            expect(exit, text).toBe(refusal ? (binary ? 2 : 1) : 0);
            if (refusal) expect(text).toContain(`myco logout ${serverUrl} --local-only`);
            else if (args[0] === 'logout') {
              expect(text).toContain('Signed out of');
              expect(text).toContain('Credential may stay valid on the server until it expires');
            }
            if (!binary) expect(text).toContain('LOGIN_RETURNED:[]');
          } finally {
            clearTimeout(stop);
            commandProcess.stdin!.destroy();
            if (commandProcess.exitCode === null && commandProcess.signalCode === null) commandProcess.kill('SIGKILL');
          }
        }
      }
    } finally {
      clearTimeout(timer!);
      child.stdin!.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill(tty ? 'SIGTERM' : 'SIGKILL');
      await local.stop(true);
      await foreign?.stop(true);
      e.sqlite.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);
}
