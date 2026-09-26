/**
 * `myco doctor`, `myco logs`, `myco config` and `myco --help` in a joined
 * project with no 1.4 vault: the member's own wiring and logs, the Deployment's
 * settings over the member credential, and the member's command list — with no
 * vault, Grove, daemon state or database left on the machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { MEMBER_SECTION, MEMBER_USAGE, helpText, runMemberVerb } from '@myco/cli/member-dispatch.js';
import { runProvision } from '@myco/cli/member.js';
import { MEMBER_SETTINGS_ISSUE, MEMBER_TIER_LEAVES } from '@myco/cli/member-config.js';
import type { MemberVerb } from '@myco/cli/member-verbs.js';
import { describeWorkerService } from '@myco/cli/worker-service.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { REJOIN_HINT } from '@myco/member/delivery-notice.js';
import { readRegistryEntry, registryEntryPath } from '@myco/member/registry.js';
import { unmemberedDir } from '@myco/member/no-membership.js';
import { MemberSpool } from '@myco/member/spool.js';
import type { FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from '../member/helpers/server.js';
import { recordingFetch, registerTestMember } from '../member/helpers/hooks.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';

let mycoHome: string;
let checkout: string;
let userHome: string;
const savedHome = process.env.MYCO_HOME;
const savedUserHome = process.env.HOME;

function freshCheckout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-machine-')));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  checkout = freshCheckout();
  userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-user-')));
  process.env.HOME = userHome;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  if (savedUserHome === undefined) delete process.env.HOME; else process.env.HOME = savedUserHome;
  resetMachineIdCache();
});

function legacyArtifacts(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (['.myco', 'groves', 'daemon.json', 'daemon.lock', 'service', 'myco.yaml', 'config.yaml'].includes(entry.name)) found.push(full);
      else if (/\.(db|sqlite)(-wal|-shm)?$/.test(entry.name)) found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  for (const dir of [checkout, mycoHome, userHome]) walk(dir);
  return found;
}

/** Claude Code's global settings file, which is also its hooks file. */
function writeClaudeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
}

const join = (rig: Pick<MemberRig, 'token' | 'tokenId' | 'expiresAt'>): void => {
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL, root: checkout });
};

/** The worker probe runs no platform command: it reads the unit file, which a fresh home does not have. */
const worker = () => ({ home: userHome, runner: () => ({ status: 1, stdout: '' }) });

async function verb(name: MemberVerb, args: string[], fetchImpl: FetchLike): Promise<{ answered: boolean | null; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as never;
  try {
    const answered = await runMemberVerb(name, args, {
      cwd: checkout, mycoHome, fetch: fetchImpl, stdout: (l) => out.push(l), stderr: (l) => err.push(l),
      worker: worker(),
    });
    return { answered, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }
}

const leaf = (rig: MemberRig, name: string, value: unknown): void => {
  rig.env.sqlite.query('INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(value), Date.now(), 'mem_machine_1');
};

describe('a joined member with no 1.4 vault', () => {
  it('takes the 1.4 handler only for a root with no membership', async () => {
    const rig = await memberRig();
    for (const name of ['doctor', 'logs', 'config'] as const) expect((await verb(name, ['get'], rig.fetch)).answered).toBeNull();
    expect(legacyArtifacts()).toEqual([]);
  });

  it('config get reads the Deployment\'s settings over the member credential, and lists the Member leaves as not honoured', async () => {
    const rig = await memberRig();
    join(rig);
    leaf(rig, 'agent.limits.concurrent_runs', 3);

    const all = await verb('config', ['get'], rig.fetch);
    expect(all.stderr).toBe('');
    expect(all.answered).toBe(true);
    expect(all.stdout).toContain(`=== Deployment Settings (${SERVER_URL}) ===`);
    expect(all.stdout).toContain('agent.limits.concurrent_runs = 3');
    expect(all.stdout).toContain(`Not read by the 2.0 member yet (${MEMBER_SETTINGS_ISSUE})`);
    for (const member of MEMBER_TIER_LEAVES) expect(all.stdout).toContain(`  ${member}`);

    const one = await verb('config', ['get', 'agent.limits.concurrent_runs'], rig.fetch);
    expect({ answered: one.answered, stdout: one.stdout }).toEqual({ answered: true, stdout: '3' });
    expect(legacyArtifacts()).toEqual([]);
  });

  it('config refuses a Member leaf on get and set, and a Deployment write, and writes nothing', async () => {
    const rig = await memberRig();
    join(rig);
    const spy = recordingFetch(rig.fetch);

    const get = await verb('config', ['get', 'capture.plan_dirs'], spy.fetch);
    expect(get.answered).toBe(false);
    expect(get.stderr).toContain(`capture.plan_dirs is a Member setting, and the 2.0 member does not read Member settings yet (${MEMBER_SETTINGS_ISSUE})`);
    const set = await verb('config', ['set', 'daemon.log_level', 'debug'], spy.fetch);
    expect(set.answered).toBe(false);
    expect(set.stderr).toContain('daemon.log_level is a Member setting');
    expect(spy.requests).toEqual([]);

    const deploymentWrite = await verb('config', ['set', 'agent.limits.concurrent_runs', '9'], spy.fetch);
    expect(deploymentWrite.answered).toBe(false);
    expect(deploymentWrite.stderr).toContain(`Deployment Settings are written in the dashboard (${SERVER_URL}/settings)`);
    expect(rig.env.sqlite.query("SELECT COUNT(*) AS n FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'").get()).toEqual({ n: 0 });
    expect(legacyArtifacts()).toEqual([]);
  });

  it('config never carries a stored provider credential', async () => {
    const rig = await memberRig();
    join(rig);
    const secret = 'sk-parity-secret-value-that-must-not-cross';
    await deploymentSecretStore(rig.env.db, wrappingKeyFromText(async () => btoa('k'.repeat(32)), 'test')).put('anthropic', secret, 'mem_machine_1', Date.now());
    expect(rig.env.sqlite.query('SELECT COUNT(*) AS n FROM deployment_secrets').get()).toEqual({ n: 1 });
    const spy = recordingFetch(rig.fetch);

    const all = await verb('config', ['get'], spy.fetch);
    expect(all.answered).toBe(true);
    expect(all.stdout).not.toContain(secret);
    const settingsRead = spy.requests.find((r) => r.path === '/members/settings');
    expect(settingsRead).toBeDefined();
    const answer = await (await rig.fetch('https://s/members/settings', { method: 'POST', headers: { ...rig.headers(), 'content-type': 'application/json' }, body: '{}' })).text();
    expect(answer).toContain('"persisted":true');
    expect(answer).not.toContain(secret);
  });

  it('the settings read strips userinfo, query and fragment from every URL a leaf holds, and creates no Project whatever the request names', async () => {
    const rig = await memberRig();
    join(rig);
    const shapes: Record<string, [string, string]> = {
      'agent.provider.base_url': ['https://reader:hunter2@llm.example/v1?api_key=sk-inline#frag', 'https://llm.example/v1'],
      'embedding.base_url': ['reader:hunter2@llm.internal:8080/v1?key=sk-inline', 'llm.internal:8080/v1'],
      'embedding.provider': ['//reader:hunter2@h.example/p?q=sk-inline', '//h.example/p'],
      'instructions.template': [
        'See {"url":"https://reader:hunter2@h.example/p?key=sk-inline"} and https://docs.example/guide?token=sk-inline, or mail bob@example.com.',
        'See {"url":"https://h.example/p"} and https://docs.example/guide, or mail bob@example.com.',
      ],
      'agent.limits.concurrent_runs': ['https://h.example/p?x=a@b', 'https://h.example/p'],
    };
    for (const [name, [stored]] of Object.entries(shapes)) leaf(rig, name, stored);
    const projects = rig.rows('projects');

    const res = await rig.fetch('https://s/members/settings', { method: 'POST', headers: { ...rig.headers({ 'x-myco-project': 'proj_never_seen' }), 'content-type': 'application/json' }, body: '{}' });
    const text = await res.text();
    const leaves = (JSON.parse(text) as { leaves: Array<{ leaf: string; value: unknown; updatedBy: string | null }> }).leaves;
    for (const [name, [, shown]] of Object.entries(shapes)) {
      expect({ name, value: leaves.find((l) => l.leaf === name)?.value }).toEqual({ name, value: shown });
    }
    expect(leaves.find((l) => l.leaf === 'agent.provider.base_url')?.updatedBy).toBe('mem_machine_1');
    for (const hidden of ['hunter2', 'reader', 'sk-inline', 'frag']) expect(text).not.toContain(hidden);
    expect(rig.rows('projects')).toBe(projects);
    expect(rig.env.sqlite.query("SELECT COUNT(*) AS n FROM projects WHERE project_id = 'proj_never_seen'").get()).toEqual({ n: 0 });

    const shown = await verb('config', ['get', 'agent.provider.base_url'], rig.fetch);
    expect(shown.stdout).toBe('https://llm.example/v1');
  });

  it('doctor reports the membership, the Deployment, the credential and the spool, and fails naming the missing capture', async () => {
    const rig = await memberRig();
    join(rig);

    const ran = await verb('doctor', [], rig.fetch);

    expect(ran.answered).toBe(false);
    expect(ran.stdout).toContain('myco doctor (member)');
    expect(ran.stdout).toMatch(/Membership\s+.*ok.*project proj_1 on https:\/\/member-test\.invalid/);
    expect(ran.stdout).toMatch(/Deployment\s+.*ok.*answers, and serves this machine's credential \d+ tools/);
    expect(ran.stdout).toMatch(/Credential\s+.*ok.*expires/);
    expect(ran.stdout).toMatch(/Spool\s+.*ok.*nothing waiting to deliver/);
    expect(ran.stdout).toMatch(/Capture\s+.*FAIL.*no harness on this machine captures for the member/);
    expect(ran.stdout).not.toMatch(/Vault|Database|Daemon|Grove/);
    expect(legacyArtifacts()).toEqual([]);
  });

  it('doctor reports a provisioned harness\'s member capture and MCP entry', async () => {
    const rig = await memberRig();
    join(rig);
    expect(runProvision(['claude-code', '--root', checkout], { cwd: checkout, mycoHome, stdout: () => {}, stderr: () => {} })).toBe(true);

    const ran = await verb('doctor', [], rig.fetch);

    expect(ran.stdout).toMatch(/Capture\s+.*ok.*Claude Code captures for the member from its global hooks/);
    expect(ran.stdout).toMatch(/Member MCP resolution\s*.*ok.*Claude Code declares a member entry in its global configuration over http transport/);
    expect(ran.stdout).not.toMatch(/Capture\s+.*FAIL/);
  });

  it('doctor and config name a membership whose entry cannot be read, never reach the credential resolver, and record no missed capture', async () => {
    const rig = await memberRig();
    join(rig);
    const entry = registryEntryPath(checkout, mycoHome);
    fs.writeFileSync(entry, '{ not json');
    const spy = recordingFetch(rig.fetch);

    const doctor = await verb('doctor', [], spy.fetch);
    expect(doctor.answered).toBe(false);
    expect(doctor.stdout).toMatch(new RegExp(`Membership\\s+.*FAIL.*this project's membership could not be read: ${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const config = await verb('config', ['get'], spy.fetch);
    expect(config.answered).toBe(false);
    expect(config.stderr).toContain(`myco config: this project's membership could not be read: ${entry}`);
    expect(doctor.stderr + config.stderr).not.toContain('no registry entry');
    expect(spy.requests).toEqual([]);
    expect(fs.existsSync(unmemberedDir(mycoHome))).toBe(false);
    expect(legacyArtifacts()).toEqual([]);
  });

  it('doctor fails by name when the Deployment does not answer', async () => {
    const rig = await memberRig();
    join(rig);
    const down: FetchLike = async () => { throw new Error('connect ECONNREFUSED'); };

    const ran = await verb('doctor', [], down);

    expect(ran.answered).toBe(false);
    expect(ran.stdout).toMatch(/Deployment\s+.*FAIL.*https:\/\/member-test\.invalid did not answer its health route/);
    expect(legacyArtifacts()).toEqual([]);
  });

  it('doctor renews a token that lapsed inside its lineage, and reports the successor', async () => {
    const rig = await memberRig({ now: Date.now() - 20 * DAY_MS });
    join(rig);
    const spy = recordingFetch(rig.fetch);

    const ran = await verb('doctor', [], spy.fetch);

    expect(spy.requests[0].path).toBe('/tokens/refresh');
    expect(readRegistryEntry(checkout, mycoHome)!.token).not.toBe(rig.token);
    expect(ran.stdout).toMatch(/Deployment\s+.*ok/);
    expect(ran.stdout).toMatch(/Credential\s+.*ok/);
  });

  it('doctor fails the credential by name, with the recovery, once the Deployment refuses it for good', async () => {
    const rig = await memberRig();
    join(rig);
    rig.env.sqlite.query('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').run(Date.now(), rig.tokenId);

    const ran = await verb('doctor', [], rig.fetch);

    expect(ran.answered).toBe(false);
    expect(ran.stdout).toMatch(/Deployment\s+.*FAIL.*refused this machine's tool list \(unauthorized\)/);
    expect(ran.stdout).toMatch(/Credential\s+.*FAIL.*the Deployment will not renew this credential/);
    expect(ran.stdout).toContain(REJOIN_HINT);
  });

  it('logs shows the worker\'s own log files and the events the Deployment refused, not a daemon log', async () => {
    const rig = await memberRig();
    join(rig);
    const status = describeWorkerService(SERVER_URL, { ...worker(), mycoHome })!;
    fs.mkdirSync(path.dirname(status.outLog), { recursive: true });
    fs.writeFileSync(status.outLog, ['worker attached', 'claimed run r_1', 'run r_1 ended'].join('\n') + '\n');
    new MemberSpool(PROJECT, { mycoHome }).appendRefused({ eventId: '0f0e0d0c-0b0a-4908-8706-050403020100', sessionId: 'sess-1', kind: 'session.start', code: 'parse', reason: 'bad', at: Date.UTC(2026, 8, 24) });

    const ran = await verb('logs', ['--tail', '2'], rig.fetch);

    expect(ran.stderr).toBe('');
    expect(ran.answered).toBe(true);
    expect(ran.stdout).toContain(`=== worker output (${SERVER_URL}): ${status.outLog} ===`);
    expect(ran.stdout).toContain('claimed run r_1\nrun r_1 ended');
    expect(ran.stdout).not.toContain('worker attached');
    expect(ran.stdout).toContain(`=== worker errors (${SERVER_URL}): ${status.errLog} ===\n  (no log yet)`);
    expect(ran.stdout).toContain('2026-09-24T00:00:00.000Z session.start 0f0e0d0c-0b0a-4908-8706-050403020100 session sess-1: parse');
    expect(ran.stdout).not.toContain('daemon.log');
    expect(legacyArtifacts()).toEqual([]);

    const bad = await verb('logs', ['--tail', 'x'], rig.fetch);
    expect(bad.answered).toBe(false);
    expect(bad.stderr).toContain('Usage: myco logs');
  });

  it('help lists the member\'s commands for a joined root or a home with no 1.4 install, and the 1.4 list otherwise', async () => {
    const rig = await memberRig();
    const LEGACY = 'Usage: myco <command> [args]\n\nCommands:\n  grove <subcommand>       Manage local Groves\n';
    const help = (cwd: string) => helpText(LEGACY, { cwd, mycoHome });
    expect(help(checkout)).toBe(MEMBER_USAGE);
    fs.mkdirSync(path.join(mycoHome, 'groves'));
    expect(help(checkout)).toBe(LEGACY);
    join(rig);
    expect(help(checkout)).toBe(MEMBER_USAGE);
    const unjoined = help(freshCheckout());
    expect(unjoined.startsWith(LEGACY)).toBe(true);
    expect(unjoined).toContain(MEMBER_SECTION);
    for (const retired of [/\bgrove\b/i, /\bdaemon\b/i, /^\s+mcp\b/m, /stdio/i, /^\s+hook\b/m, /^\s+restart\b/m, /^\s+service\b/m]) {
      expect(MEMBER_USAGE).not.toMatch(retired);
    }
    for (const kept of ['search <query>', 'session [id|latest]', 'stats', 'doctor', 'logs', 'config get', 'login <invite-link>', 'member <op>']) {
      expect(MEMBER_USAGE).toContain(kept);
    }
  });

  it('doctor does not count 1.4 capture as the member\'s, whatever else in the file carries a credential flag', async () => {
    const rig = await memberRig();
    join(rig);
    writeClaudeSettings({
      permissions: { allow: ['Bash(myco tool call --credential registry:*)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'myco-run hook session-start' }] }] },
    });

    const ran = await verb('doctor', [], rig.fetch);

    expect(ran.stdout).toMatch(/Capture\s+.*!!.*Claude Code's global hooks .* are Myco's 1\.4 capture, not the member's/);
    expect(ran.stdout).toMatch(/Capture\s+.*FAIL.*no harness on this machine captures for the member/);
    expect(ran.stdout).not.toContain('captures for the member from');
  });

  it('doctor reports a 1.4 OpenCode plugin as 1.4 capture, and the member plugin as the member\'s', async () => {
    const rig = await memberRig();
    join(rig);
    const plugin = path.join(userHome, '.config', 'opencode', 'plugins', 'myco.ts');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, '// myco:plugin-marker\nexport const MycoPlugin = async () => ({});\n');

    const legacy = await verb('doctor', [], rig.fetch);
    expect(legacy.stdout).toMatch(/Capture\s+.*!!.*OpenCode's global hooks .* are Myco's 1\.4 capture, not the member's/);
    expect(legacy.stdout).not.toContain('OpenCode captures for the member');

    fs.writeFileSync(plugin, '// myco:plugin-marker\n// myco:member-plugin\nexport const MycoPlugin = async () => ({});\n');
    const member = await verb('doctor', [], rig.fetch);
    expect(member.stdout).toMatch(/Capture\s+.*ok.*OpenCode captures for the member from its global hooks/);
  });

  it('doctor reads Codex member hooks from a hooks.json that carries a TOML footer', async () => {
    const rig = await memberRig();
    join(rig);
    const program = path.join(userHome, 'bin', 'myco');
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(program, '#!/bin/sh\n', { mode: 0o755 });
    const hooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${program} hook session-start --symbiont codex --credential registry --myco-managed` }] }] } };
    fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(userHome, '.codex', 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n\n[features]\ncodex_hooks = true\n`);

    const ran = await verb('doctor', [], rig.fetch);

    expect(ran.stdout).toMatch(/Capture\s+.*ok.*Codex captures for the member from its global hooks/);
  });

  it('doctor names a member hook whose program is missing or not executable, and counts it as no capture', async () => {
    const rig = await memberRig();
    join(rig);
    const program = path.join(userHome, 'bin', 'myco');
    const member = (event: string) => ({ hooks: [{ type: 'command', command: `${program} hook ${event} --symbiont claude-code --credential registry --myco-managed` }] });
    writeClaudeSettings({ hooks: { SessionStart: [member('session-start')], Stop: [member('stop')] } });

    const missing = await verb('doctor', [], rig.fetch);
    expect(missing.stdout).toContain(`run ${program}, which is missing, so they capture nothing. Run \`myco member provision claude-code\` from this project.`);
    expect(missing.stdout).toMatch(/Capture\s+.*FAIL.*no harness on this machine captures for the member/);

    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(program, '#!/bin/sh\n', { mode: 0o644 });
    const inert = await verb('doctor', [], rig.fetch);
    expect(inert.stdout).toContain(`run ${program}, which is not executable`);

    fs.chmodSync(program, 0o755);
    const runnable = await verb('doctor', [], rig.fetch);
    expect(runnable.stdout).toMatch(/Capture\s+.*ok.*Claude Code captures for the member from its global hooks/);
  });

  it('config get answers before a Deployment that stops answering holds it past the request deadline', async () => {
    const rig = await memberRig();
    join(rig);
    const stalls: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== '/members/settings') return rig.fetch(request);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
    };
    const started = Date.now();
    const out: string[] = [];
    const err: string[] = [];
    const answered = await runMemberVerb('config', ['get'], { cwd: checkout, mycoHome, fetch: stalls, requestTimeoutMs: 200, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(answered).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err.join('\n')).toContain('did not answer its settings (timeout): no answer within 200 ms');
  });

  it('config get names a Deployment that does not serve the settings read, and renews nothing', async () => {
    const rig = await memberRig();
    join(rig);
    const older: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/members/settings') url.pathname = '/members/settings-not-served';
      return rig.fetch(new Request(url, request));
    };
    const spy = recordingFetch(older);
    const token = readRegistryEntry(checkout, mycoHome)!.token;

    const ran = await verb('config', ['get'], spy.fetch);

    expect(ran.answered).toBe(false);
    expect(ran.stderr).toContain('did not answer its settings (route_missing): the Deployment does not serve /members/settings; update it');
    expect(spy.requests.filter((r) => r.path === '/tokens/refresh')).toEqual([]);
    expect(readRegistryEntry(checkout, mycoHome)!.token).toBe(token);
  });
});

describe('the Member leaves the config verb names', () => {
  it('are exactly the §7.8 rows whose tier is Member', () => {
    const doc = fs.readFileSync(path.resolve('docs/architecture/myco-2.0.md'), 'utf8');
    const ledger = [...doc.matchAll(/^\| `([^`]+)` \| [A-Z]+ \| Member \|/gm)].map((m) => m[1]).sort();
    expect([...MEMBER_TIER_LEAVES].sort()).toEqual(ledger);
  });
});
