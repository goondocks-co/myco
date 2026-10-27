import { run as runCutover,type CutoverDeps } from '@myco/cli/cutover.js';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LaunchctlRunner } from '@myco/member/legacy-service/launchd.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { memberRig,tempMycoHome,TEST_MACHINE_ID,type MemberRig } from '../member/helpers/server.js';

export const SERVER = 'https://member-test.invalid';
export const PROJECT = 'proj_1';
export const NOW_S = Math.floor(Date.now() / 1000);
export const DAEMON_LABEL = 'co.goondocks.myco';
export const OTHER_DAEMON_LABEL = 'co.goondocks.myco.0ther000';
export const WORKER_LABEL = 'co.goondocks.myco-worker.0ther000';

export type RunOpts = { platform?: CutoverDeps['platform']; schtasks?: CutoverDeps['schtasks']; stopDaemon?: CutoverDeps['stopDaemon']; signal?: AbortSignal; fetch?: MemberRig['fetch']; mycoHome?: string | null; env?: NodeJS.ProcessEnv; provision?: CutoverDeps['provision']; agents?: string[]; unitDirs?: CutoverDeps['unitDirs'] };
export interface Machine {
  rig: MemberRig;
  home: string;
  legacyHome: string;
  mycoHome: string;
  root: string;
  vault: string;
  agentsDir: string;
  /** Every launchctl call, and the labels launchd holds. */
  launchctl: { calls: string[][]; loaded: Set<string> };
  planned: string[][];
  done: string[];
  run: (args?: string[], opts?: RunOpts) => Promise<{ ok: boolean; out: string[]; err: string[] }>;
}

export const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
export const writeJson = (file: string, value: unknown): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

/** A launchd unit file as Myco writes one. */
export function plist(label: string, argv: string[], env: Record<string, string>): string {
  const str = (v: string) => `<string>${v}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key>${str(label)}`
    + `<key>ProgramArguments</key><array>${argv.map(str).join('')}</array>`
    + `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key>${str(v)}`).join('')}</dict>`
    + '<key>RunAtLoad</key><true/></dict></plist>\n';
}

/** A launchctl that answers for the labels it holds and drops one on bootout. */
export function fakeLaunchctl(loaded: Set<string>, calls: string[][]): LaunchctlRunner {
  return {
    run: async (args) => {
      calls.push(args);
      const label = (args[args.length - 1] ?? '').split('/').pop() ?? '';
      if (args[0] === 'print') return loaded.has(label) ? { stdout: 'state = running', exitCode: 0 } : { stdout: `Could not find service "${label}" in domain`, exitCode: 113 };
      if (args[0] === 'bootout') loaded.delete(label);
      return { stdout: '', exitCode: 0 };
    },
  };
}

export async function machine(opts: { legacyHome?: string } = {}): Promise<Machine> {
  const rig = await memberRig();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cutover-')));
  const legacyHome = opts.legacyHome === undefined ? path.join(home, '.myco') : path.join(home, opts.legacyHome);
  const root = path.join(home, 'Repos', 'app');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  const legacyBin = path.join(legacyHome, 'bin', 'myco');

  // The 1.4 vault.
  const vault = path.join(legacyHome, 'groves', 'grove_a', 'myco.db');
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  db.run('PRAGMA foreign_keys = OFF');
  db.run(`INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, title, created_at) VALUES (?, 'claude-code', ?, ?, ?, ?, 'completed', 'A 1.4 session', ?)`,
    ['00000000-0000-4000-8000-000000000001', root, PROJECT, NOW_S - 86_400 * 40, NOW_S - 86_400 * 40 + 600, NOW_S - 86_400 * 40]);
  db.run(`INSERT INTO prompt_batches (id, project_id, session_id, prompt_number, user_prompt, origin, started_at, created_at) VALUES (1, ?, ?, 1, 'hello from 1.4', 'human', ?, ?)`,
    [PROJECT, '00000000-0000-4000-8000-000000000001', NOW_S - 86_400 * 40, NOW_S - 86_400 * 40]);
  db.run(`INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at) VALUES ('gotcha-1', ?, 'user', 'gotcha', 'active', 'kept', ?)`, [PROJECT, NOW_S]);
  // The writer's pages are folded into the file before the byte comparison starts: the fixture's own
  // handle closing later must not read as the cutover writing the vault.
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  // 1.4's claim on the agents' settings, its hooks beside the person's own, and its MCP entry.
  fs.mkdirSync(path.join(legacyHome, 'claims'), { recursive: true });
  fs.writeFileSync(path.join(legacyHome, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: legacyHome, pid: 1, claimed_at: 1 }));
  const hook = (event: string) => ({ hooks: [{ type: 'command', command: `${legacyBin} hook ${event} --symbiont claude-code --myco-managed` }] });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [hook('session-start')], Stop: [hook('stop'), { hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { myco: { command: legacyBin, args: ['mcp'] } } }, null, 2));

  // The 1.4 daemon's unit, beside another home's daemon and worker units.
  const agentsDir = path.join(home, 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${DAEMON_LABEL}.plist`), plist(DAEMON_LABEL, [legacyBin, 'daemon'], { MYCO_HOME: legacyHome }));
  fs.writeFileSync(path.join(agentsDir, `${OTHER_DAEMON_LABEL}.plist`), plist(OTHER_DAEMON_LABEL, ['/elsewhere/other/bin/myco', 'daemon'], { MYCO_HOME: '/elsewhere/other' }));
  fs.writeFileSync(path.join(agentsDir, `${WORKER_LABEL}.plist`), plist(WORKER_LABEL, ['/elsewhere/other/bin/myco', 'worker', '--server', SERVER], { MYCO_HOME: '/elsewhere/other' }));
  const launchctl = { calls: [] as string[][], loaded: new Set([DAEMON_LABEL, OTHER_DAEMON_LABEL, WORKER_LABEL]) };

  const mycoHome = tempMycoHome();
  writeDeploymentMembership({ serverUrl: SERVER, token: rig.token, tokenId: rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });

  const planned: string[][] = [];
  const done: string[] = [];
  const run: Machine['run'] = async (args = [], o = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const ok = await runCutover(args, {
      signal: o.signal, fetch: o.fetch ?? rig.fetch, mycoHome: o.mycoHome === null ? undefined : (o.mycoHome ?? mycoHome), machineId: TEST_MACHINE_ID,
      env: o.env ?? { ...process.env, HOME: home, MYCO_LAUNCH_AGENTS_DIR: agentsDir },
      sleep: async () => {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), packageRoot: resolvePackageRoot(),
      agents: () => o.agents ?? ['claude-code'], platform: o.platform ?? 'darwin', schtasks: o.schtasks,
      launchctl: fakeLaunchctl(launchctl.loaded, launchctl.calls),
      stopDaemon: o.stopDaemon ?? (async () => 'none'),
      provision: o.provision,
      unitDirs: o.unitDirs,
      onPlan: (keys) => planned.push(keys),
      onAction: (key) => done.push(key),
    });
    return { ok, out, err };
  };
  return { rig, home, legacyHome, mycoHome, root, vault, agentsDir, launchctl, planned, done, run };
}

