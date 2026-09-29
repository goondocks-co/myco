/**
 * The sandbox path: one environment variable, no local configuration, and a
 * machine that captures.
 *
 * The gate #1158 names is here — a runtime holding only a join code reaches the
 * Deployment and lands a session and its plan. The second gate is the race: two
 * hooks starting together must BOTH capture, on one credential, from one
 * single-use code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { ENV_JOIN_CODE } from '@myco/member/constants.js';
import { ensureJoinedFromCode, exchangeJoinCode, parseJoinCode, JOIN_CODE_REFUSALS } from '@myco/member/join-code.js';
import { readDeploymentMembership, readRegistryEntry } from '@myco/member/registry.js';
import { tempMycoHome, unjoinedRig } from './helpers/server.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { runHook } from './helpers/hooks.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL, parseCredentialFlag, redeemsJoinCode, resolveCredential, resolveMemberProjectRoot, type CredentialSource } from '@myco/member/credential.js';
import { issueMemberToken, NO_RUNTIME_CLAIMS } from '@myco-server-worker/auth/tokens.js';
import { run as runSettings } from '@myco/cli/settings.js';

const KEY = 'k'.repeat(43);

describe('reading a join code', () => {
  it('splits a well-formed link into the Deployment and the invitation, and keeps the key out of the path', () => {
    expect(parseJoinCode('https://myco.example.com/join#' + KEY)).toEqual({ serverUrl: 'https://myco.example.com', key: KEY });
    expect(parseJoinCode('  https://myco.example.com/join/#' + KEY + '  ')).toEqual({ serverUrl: 'https://myco.example.com', key: KEY });
  });

  it('admits a loopback Deployment over plain http, which is where a laptop serves itself', () => {
    expect(parseJoinCode('http://127.0.0.1:8787/join#' + KEY)).toEqual({ serverUrl: 'http://127.0.0.1:8787', key: KEY });
  });

  it('names what is wrong with every link it refuses, and refuses each on the string alone', () => {
    const cases: Array<[string, keyof typeof JOIN_CODE_REFUSALS]> = [
      ['not a url at all', 'not_a_url'],
      ['http://myco.example.com/join#' + KEY, 'not_https'],
      ['https://myco.example.com/enroll#' + KEY, 'wrong_path'],
      ['https://myco.example.com/join', 'no_key'],
      ['https://myco.example.com/join#short', 'key_grammar'],
    ];
    for (const [value, error] of cases) expect({ value, parsed: parseJoinCode(value) }).toEqual({ value, parsed: { error } });
  });
});

describe('spending a join code', () => {
  it('exchanges a Project-bound code for a credential, and answers what it granted and bound', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });

    const result = await exchangeJoinCode({ serverUrl: 'https://s', key: issued.key }, { fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox', forProject: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ role: result.answer.role, projectId: result.answer.projectId }).toEqual({ role: 'member', projectId: 'proj_1' });
    expect(r.rows('member_credentials')).toBe(1);
  });

  it('reports the Deployment\'s own refusal rather than a failure to reach it', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member' });
    const code = { serverUrl: 'https://s', key: issued.key };

    const refused = await exchangeJoinCode(code, { fetch: r.fetch as typeof fetch, machineId: 'machine_np', forProject: true });
    expect(refused).toMatchObject({ ok: false, code: 'enrollment_no_project' });
    expect(r.rows('member_credentials')).toBe(0);
  });

  it('reports an unreachable Deployment as unreachable, spending nothing', async () => {
    const dead = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const result = await exchangeJoinCode({ serverUrl: 'https://s', key: KEY }, { fetch: dead as unknown as typeof fetch, machineId: 'm' });
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
  });
});

describe('a sandbox holding only a join code', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-join-'));
    env = {};
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('joins on its first hook and records a credential the next hook reads, with no configuration of any kind', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-'));

    expect(readDeploymentMembership('https://s', home)).toBe(null);
    await ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' });

    const membership = readDeploymentMembership('https://s', home);
    expect(membership?.serverUrl).toBe('https://s');
    expect(membership?.token).toBeTruthy();
    // The Project the code named is bound to the root, so a hook resolves a full credential.
    expect(readRegistryEntry(root, home)?.projectId).toBe('proj_1');

    // A second hook spends nothing: one credential on the Deployment, whatever the hook count.
    await ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' });
    expect(r.rows('member_credentials')).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lets BOTH of two hooks starting together capture, on the one credential the single-use code yields', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-'));

    const both = [0, 1].map(() => ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' }));
    await Promise.all(both);

    // One exchange, one credential — and a membership every hook can read.
    expect(r.rows('member_credentials')).toBe(1);
    expect(readDeploymentMembership('https://s', home)?.token).toBeTruthy();
    expect(readRegistryEntry(root, home)?.projectId).toBe('proj_1');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the binding under the root a hook resolves, so the very next resolve finds a credential', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-'));

    await ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' });

    // What `resolveCredential` needs: an entry keyed on that root, naming a Project and carrying a token.
    const entry = readRegistryEntry(root, home);
    expect({ projectId: entry?.projectId, hasToken: Boolean(entry?.token), root: entry?.root }).toEqual({ projectId: 'proj_1', hasToken: true, root });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does nothing at all when no join code is set, which is every run outside a sandbox', async () => {
    const r = unjoinedRig();
    await ensureJoinedFromCode({ env, mycoHome: home, fetch: r.fetch as typeof fetch });
    expect(readDeploymentMembership('https://s', home)).toBe(null);
    expect(r.rows('member_credentials')).toBe(0);
  });

  it('writes nothing when the Deployment refuses the code, leaving the machine as it found it', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;

    await ensureJoinedFromCode({ env, mycoHome: home, fetch: r.fetch as typeof fetch, machineId: 'machine_np' });
    expect(readDeploymentMembership('https://s', home)).toBe(null);
    expect(r.rows('member_credentials')).toBe(0);
  });

  it('writes nothing for a malformed code, and never reaches the Deployment with one', async () => {
    const r = unjoinedRig();
    let calls = 0;
    const counting = ((input: string | URL | Request, init?: RequestInit) => { calls += 1; return r.fetch(input, init); }) as typeof fetch;
    env[ENV_JOIN_CODE] = 'https://s/join#short';

    await ensureJoinedFromCode({ env, mycoHome: home, fetch: counting });
    expect({ calls, membership: readDeploymentMembership('https://s', home) }).toEqual({ calls: 0, membership: null });
  });
});

/**
 * The gate #1158 names, at the level it names it: a real hook, driven the way
 * the CLI dispatcher drives one, on a machine holding nothing but a join code.
 *
 * Nothing here writes a registry entry first. If the exchange does not happen
 * the hook resolves no credential and lands nothing, so every assertion below
 * is downstream of the redemption actually working.
 */
describe('a hook on a machine holding only a join code', () => {
  let mycoHome: string;
  let rig: ReturnType<typeof unjoinedRig>;
  const savedHome = process.env.MYCO_HOME;
  const savedCode = process.env[ENV_JOIN_CODE];

  const transcriptWithPlan = (sessionId: string): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-join-tx-')), `${sessionId}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'a plan <ultraplan>\n# Sandbox Plan\n\nstep one\n</ultraplan> done' }], stop_reason: 'end_turn' } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };

  beforeEach(async () => {
    mycoHome = tempMycoHome();
    process.env.MYCO_HOME = mycoHome;
    resetMachineIdCache();
    rig = unjoinedRig();
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    process.env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    if (savedCode === undefined) delete process.env[ENV_JOIN_CODE]; else process.env[ENV_JOIN_CODE] = savedCode;
    resetMachineIdCache();
  });

  it('redeems the code and lands a session and its plan, with no registry entry to start from', async () => {
    const session = 'sess-join-code-1';
    const tx = transcriptWithPlan(session);
    expect(readRegistryEntry(resolveMemberProjectRoot(), mycoHome)).toBe(null);

    await runHook('session-start', { session_id: session, transcript_path: tx, cwd: '/work/repo' }, { fetch: rig.fetch });
    await runHook('stop', { session_id: session, transcript_path: tx, last_assistant_message: '' }, { fetch: rig.fetch });
    // The segment the hook shipped is read by the Deployment's parse, which writes the plan.
    for (let pass = 0; pass < 20 && (await parseTranscripts(rig.env.serverEnv, Date.now())) > 0; pass += 1) { /* until nothing is pending */ }

    expect(rig.env.sqlite.query(`SELECT project_id FROM sessions WHERE session_id = ?`).get(session)).toEqual({ project_id: 'proj_1' });
    expect(rig.env.sqlite.query(`SELECT title, content FROM plans`).get()).toEqual({ title: 'Sandbox Plan', content: '# Sandbox Plan\n\nstep one' });
    expect(rig.rows('member_credentials')).toBe(1);
    fs.rmSync(path.dirname(tx), { recursive: true, force: true });
  });

  it('lets a second hook capture on the credential the first redeemed, spending the code once', async () => {
    const first = 'sess-join-code-a';
    const second = 'sess-join-code-b';
    const txA = transcriptWithPlan(first);
    const txB = transcriptWithPlan(second);

    await runHook('session-start', { session_id: first, transcript_path: txA, cwd: '/work/repo' }, { fetch: rig.fetch });
    await runHook('session-start', { session_id: second, transcript_path: txB, cwd: '/work/repo' }, { fetch: rig.fetch });

    // Both sessions landed, and the single-use code was spent exactly once for them.
    expect((rig.env.sqlite.query(`SELECT session_id FROM sessions ORDER BY session_id`).all() as Array<{ session_id: string }>).map((r) => r.session_id))
      .toEqual([first, second].sort());
    expect(rig.rows('member_credentials')).toBe(1);
    for (const tx of [txA, txB]) fs.rmSync(path.dirname(tx), { recursive: true, force: true });
  });

  it('lands nothing when the code is refused: no credential, no session, and the hook stays silent on stdout', async () => {
    const session = 'sess-join-code-refused';
    const tx = transcriptWithPlan(session);
    // An invitation naming no Project: a sandbox cannot bind one, and the server refuses it.
    const free = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member' });
    process.env[ENV_JOIN_CODE] = `https://s/join#${free.key}`;

    const { stdout } = await runHook('session-start', { session_id: session, transcript_path: tx, cwd: '/work/repo' }, { fetch: rig.fetch });

    expect(rig.rows('member_credentials')).toBe(0);
    expect(rig.rows('sessions')).toBe(0);
    expect(stdout.trim()).toBe('');
    fs.rmSync(path.dirname(tx), { recursive: true, force: true });
  });
});

/**
 * The documented sandbox (#1460): the hooks `myco settings` emits, which
 * declare `--credential env`, and a `MYCO_JOIN_CODE` — with none of the env
 * triplet set. The first hook redeems the code and captures on it; the second
 * captures on the same credential.
 *
 * And the rule the code's single use imposes: a hook spends the code only when
 * it will capture on what the code yields. Spent and not captured is the
 * failure this gates — a code gone and a machine that never captures.
 */
describe('the emitted sandbox settings with a join code', () => {
  let mycoHome: string;
  let rig: ReturnType<typeof unjoinedRig>;
  const KEYS = ['MYCO_HOME', ENV_JOIN_CODE, ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT] as const;
  const saved: Record<string, string | undefined> = {};

  /** The credential source the emitted SessionStart hook command declares. */
  const emittedSource = (): CredentialSource | null => {
    const out: string[] = [];
    runSettings(['--harness', 'claude-code', '--project', 'proj_1'], { stdout: (l) => out.push(l), stderr: () => {} });
    const settings = JSON.parse(out.join('\n')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    return parseCredentialFlag(settings.hooks.SessionStart[0].hooks[0].command.split(/\s+/));
  };

  /** A session's hook input, with the transcript a real session-start names. */
  const sessionInput = (sessionId: string): Record<string, unknown> => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-join-env-tx-')), `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'typed prompt' }] } })}\n`);
    return { session_id: sessionId, transcript_path: file, cwd: '/work/repo' };
  };

  const spent = (id: string): boolean =>
    (rig.env.sqlite.query(`SELECT used_at FROM enrollment_authorities WHERE id = ?`).get(id) as { used_at: number | null }).used_at !== null;
  const landed = (session: string): boolean =>
    rig.env.sqlite.query(`SELECT 1 FROM sessions WHERE session_id = ?`).get(session) !== null;

  beforeEach(async () => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    mycoHome = tempMycoHome();
    process.env.MYCO_HOME = mycoHome;
    resetMachineIdCache();
    rig = unjoinedRig();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetMachineIdCache();
  });

  it('delivers a session on the first hook, and a second session on the same credential', async () => {
    const source = emittedSource();
    expect(source).toBe('env');
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    process.env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;

    const first = await runHook('session-start', sessionInput('sess-env-code-1'), { fetch: rig.fetch, credential: source });
    expect(first.stderr).not.toContain('no capture');
    expect({ landed: landed('sess-env-code-1'), spent: spent(issued.id) }).toEqual({ landed: true, spent: true });
    const credential = readRegistryEntry(resolveMemberProjectRoot(), mycoHome);
    expect(credential?.projectId).toBe('proj_1');

    const second = await runHook('session-start', sessionInput('sess-env-code-2'), { fetch: rig.fetch, credential: source });
    expect(second.stderr).not.toContain('no capture');
    expect(landed('sess-env-code-2')).toBe(true);
    expect(rig.rows('member_credentials')).toBe(1);
    expect(readRegistryEntry(resolveMemberProjectRoot(), mycoHome)?.token).toBe(credential?.token);
  });

  it('resolves the redeemed membership as a registry credential, which rotates, and never as the orchestrator\'s non-rotating token', async () => {
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    process.env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    await runHook('session-start', sessionInput('sess-env-code-rot'), { fetch: rig.fetch, credential: 'env' });
    const record = resolveCredential('env', { mycoHome });
    expect({ source: record?.source, root: record?.root, projectId: record?.projectId }).toEqual({ source: 'registry', root: resolveMemberProjectRoot(), projectId: 'proj_1' });
  });

  it('never spends the code on a hook that would not then capture on it', async () => {
    const other = await memberRigToken(rig);
    const cases: Array<{ name: string; source: CredentialSource | null; env: Record<string, string> }> = [
      { name: 'no declared source', source: null, env: {} },
      { name: 'the env triplet supplies the credential', source: 'env', env: { [ENV_SERVER_URL]: 'https://s', [ENV_MEMBER_TOKEN]: other, [ENV_PROJECT]: 'proj_1' } },
      { name: 'a partial env triplet', source: 'env', env: { [ENV_SERVER_URL]: 'https://s' } },
      { name: 'the env source with only the code', source: 'env', env: {} },
      { name: 'the registry source with only the code', source: 'registry', env: {} },
    ];
    const outcomes: Array<{ name: string; spent: boolean; landed: boolean }> = [];
    for (const [i, c] of cases.entries()) {
      // A fresh machine per case, so an earlier case's membership answers nothing here.
      process.env.MYCO_HOME = tempMycoHome();
      fs.writeFileSync(path.join(process.env.MYCO_HOME, 'machine_id'), `machine_case_${i}`, 'utf-8');
      resetMachineIdCache();
      for (const k of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT]) delete process.env[k];
      Object.assign(process.env, c.env);
      const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
      process.env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
      const session = `sess-spend-${i}`;
      await runHook('session-start', sessionInput(session), { fetch: rig.fetch, credential: c.source });
      outcomes.push({ name: c.name, spent: spent(issued.id), landed: landed(session) });
    }
    // Spent implies landed, in every case; and the code is spent exactly where it is the credential.
    expect(outcomes.filter((o) => o.spent && !o.landed)).toEqual([]);
    expect(outcomes).toEqual([
      { name: 'no declared source', spent: false, landed: false },
      { name: 'the env triplet supplies the credential', spent: false, landed: true },
      { name: 'a partial env triplet', spent: false, landed: false },
      { name: 'the env source with only the code', spent: true, landed: true },
      { name: 'the registry source with only the code', spent: true, landed: true },
    ]);
  });

  it('decides whether a hook may spend the code from its declared source and the triplet alone', () => {
    const code = { [ENV_JOIN_CODE]: `https://s/join#${KEY}` };
    expect(redeemsJoinCode('env', code)).toBe(true);
    expect(redeemsJoinCode('registry', code)).toBe(true);
    expect(redeemsJoinCode(null, code)).toBe(false);
    expect(redeemsJoinCode('env', { ...code, [ENV_PROJECT]: 'proj_1' })).toBe(false);
    expect(redeemsJoinCode('env', {})).toBe(false);
    expect(redeemsJoinCode('registry', { [ENV_JOIN_CODE]: '  ' })).toBe(false);
  });
});

/** A member token on the rig's Deployment for `proj_1`, as an orchestrator mints one for the env triplet. */
async function memberRigToken(rig: ReturnType<typeof unjoinedRig>): Promise<string> {
  rig.env.sqlite.query(`INSERT OR IGNORE INTO members (id,label,created_at,revoked_at) VALUES ('mem_orchestrated','orchestrated',0,NULL)`).run();
  const { token } = await issueMemberToken(rig.env.db, { memberId: 'mem_orchestrated', machineId: 'machine_orchestrated' }, Date.now(), null, NO_RUNTIME_CLAIMS, { rotates: false });
  return token;
}
