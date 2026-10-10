import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repositoryName } from '@myco/utils/git.js';
import { sessionStartEvent } from '@myco/member/envelope.js';
import { runLegacyImport } from '@myco/member/legacy-import.js';
import { runHook } from '../../member/helpers/hooks.ts';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { expectPersisted, lit, MACHINE_ID, memberHeadersFor, type ParityScenario } from '../harness.ts';

export const projectNaming: ParityScenario = {
  name: 'project naming: first linked-worktree capture and 1.4 import use the repository name',
  async run(target) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-naming-')));
    const main = path.join(base, 'whisker-sites');
    const linked = path.join(base, 'w9-task-5-terraform-alerts');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
    try {
      fs.mkdirSync(main);
      git('init', '-q');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
      git('worktree', 'add', '-qb', 'worker', linked);
      const project = 'proj_worktree_name';
      const nameOf = async (id: string) => (await target.sql(`SELECT name FROM projects WHERE project_id = ${lit(id)}`))[0]?.name;
      const start = async (id: string, originPath: string, projectName?: string) => {
        const out = sessionStartEvent({ agent: 'claude-code', sessionId: crypto.randomUUID(), stage: () => { throw new Error('no blob'); } }, { originPath, projectName });
        await expectPersisted(await fetch(target.url + '/events', {
          method: 'POST', headers: memberHeadersFor(target.memberToken, id, { 'content-type': 'application/json' }), body: JSON.stringify(out.envelope),
        }), 'session start');
      };
      const heldEnv = { MYCO_SERVER_URL: process.env.MYCO_SERVER_URL, MYCO_MEMBER_TOKEN: process.env.MYCO_MEMBER_TOKEN, MYCO_PROJECT: process.env.MYCO_PROJECT };
      const cwd = process.cwd();
      try {
        Object.assign(process.env, { MYCO_SERVER_URL: target.url, MYCO_MEMBER_TOKEN: target.memberToken, MYCO_PROJECT: project });
        process.chdir(linked);
        const fetchMember = (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          request.headers.set('cf-connecting-ip', '1.2.3.4');
          return fetch(request);
        };
        const sessionId = crypto.randomUUID();
        const transcript = path.join(base, sessionId + '.jsonl');
        fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: linked, message: { role: 'user', content: 'worktree session' } }) + '\n');
        const captured = await runHook('session-start', { session_id: sessionId, hook_event_name: 'SessionStart', cwd: linked, transcript_path: transcript }, { credential: 'env', fetch: fetchMember });
        expect(captured.stderr).toBe('');
        await runHook('session-end', { session_id: sessionId, hook_event_name: 'SessionEnd', cwd: linked, transcript_path: transcript }, { credential: 'env', fetch: fetchMember });
      } finally {
        process.chdir(cwd);
        for (const [key, value] of Object.entries(heldEnv)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
      expect(await nameOf(project)).toBe('whisker-sites');
      await start(project, '/other/checkout', 'Another repository');
      expect(await nameOf(project)).toBe('whisker-sites');
      const renamed = await fetch(`${target.url}/api/projects/${project}`, {
        method: 'PATCH', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Chosen by owner' }),
      });
      expect(renamed.status).toBe(200);
      await start(project, linked, repositoryName(linked));
      expect(await nameOf(project)).toBe('Chosen by owner');
      const onboarded = 'proj_onboarded_name';
      await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES (${lit(onboarded)},'Onboarded name',0)`);
      await start(onboarded, linked, repositoryName(linked));
      expect(await nameOf(onboarded)).toBe('Onboarded name');
      await start('proj_old_client_name', '/repos/older-client');
      expect(await nameOf('proj_old_client_name')).toBe('older-client');

      const imported = 'proj_legacy_worktree_name';
      const vault = path.join(base, 'myco.db');
      const db = new Database(vault);
      try {
        db.exec(fs.readFileSync(new URL('../../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
        db.run('PRAGMA foreign_keys = OFF');
        const stamp = Date.now() - 60_000;
        db.run(`INSERT INTO sessions (id,agent,project_root,project_id,started_at,ended_at,status,created_at,machine_id)
          VALUES (?, 'claude-code', ?, ?, ?, ?, 'completed', ?, ?)`,
        [crypto.randomUUID(), linked, imported, stamp, stamp + 1_000, stamp, MACHINE_ID]);
      } finally { db.close(); }
      const mycoHome = path.join(base, 'member');
      writeDeploymentMembership({ serverUrl: target.url, token: target.memberToken, tokenId: 'mt_parity', machineId: MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });
      const report = await runLegacyImport({ sources: [vault], serverUrl: target.url }, {
        mycoHome, machineId: MACHINE_ID, fetch: (input, init) => {
          const request = new Request(input, init);
          request.headers.set('cf-connecting-ip', '1.2.3.4');
          return fetch(request);
        },
      });
      expect(report.refused).toBeUndefined();
      expect(report.projects).toHaveLength(1);
      expect(report.projects[0].failures).toEqual([]);
      expect(report.projects[0].refusals).toEqual([]);
      expect(report.projects[0].sessions.fromVault).toBe(1);
      expect(await nameOf(imported)).toBe('whisker-sites');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  },
};
