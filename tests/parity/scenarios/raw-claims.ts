import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'bun:test';
import type { DeploymentOwnershipPreview, RawClaimPreview } from '@goondocks/myco-shared/raw-claims';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { sha256Hex, utf8 } from '@myco-server-worker/hash.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { expectPersisted, lit, MEMBER_ID, memberHeadersFor, SESSION_SECRET, type ParityScenario } from '../harness.ts';

const PROJECTS = ['proj_claim_a', 'proj_claim_b'] as const;
const SESSION = 'claim_history';
const DAY_MS = 86_400_000;
const TOKEN_TTL_MS = 3_600_000;
const CLI_TIMEOUT_MS = 30_000;
const MAX_BACKFILL_WAKES = 20;

/** HTTP ownership and claims, including the source CLI over each target's real network and storage. */
export const rawClaimsParity: ParityScenario = {
  name: 'raw claims: explicit owner bootstrap, reviewed unknown-only claims and projectless CLI on native and D1',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const now = Date.now();
    const oldest = now - 3 * DAY_MS;
    const newest = now - DAY_MS;
    const write = async (statements: string[]) => {
      if (target.name === 'cloudflare') await target.sql(statements.join(';\n') + ';');
      else for (const statement of statements) await target.sql(statement);
    };
    const request = (route: string, headers: Record<string, string>, body?: Record<string, unknown>) => fetch(`${target.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...headers, origin: target.url, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bearer = (token: string) => {
      const { [PROJECT_HEADER]: _project, ...headers } = memberHeadersFor(token, target.projectId);
      return headers;
    };
    const viewer = async (label: string, role: 'admin' | 'member', sub: string) => {
      const id = `mem_claim_${label}`;
      const machine = `machine_claim_${label}`;
      const tokenId = `mt_claim_${label}`;
      const token = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x');
      await write([
        `INSERT INTO members (id,label,role,github_id,created_at) VALUES (${lit(id)},${lit(label)},${lit(role)},${lit(sub)},${now})`,
        `INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES (${lit(machine)},${lit(id)},${now})`,
        `INSERT INTO member_credentials (id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
          VALUES (${lit(tokenId)},${lit(id)},${lit(machine)},${lit(await sha256Hex(token))},${now},${now + TOKEN_TTL_MS},0,${lit(tokenId)},${now})`,
      ]);
      const session = await signSession(SESSION_SECRET, { sub, login: label, iat: now, exp: now + TOKEN_TTL_MS });
      return { id, machine, tokenId, token, headers: { cookie: `${SESSION_COOKIE}=${session}`, 'cf-connecting-ip': '1.2.3.4' } };
    };
    const owner = await viewer('owner', 'admin', '719001');
    const admin = await viewer('admin', 'admin', '719002');
    const other = await viewer('other', 'member', '719003');
    await write(PROJECTS.map((projectId, index) => `INSERT INTO projects (project_id,name,created_at) VALUES (${lit(projectId)},${lit(`Claim archive ${index + 1}`)},${now})`));
    const ownership = await (await request('/api/ownership', target.ownerHeaders())).json() as DeploymentOwnershipPreview;
    expect(ownership.ownerMemberId).toBeNull();
    expect((await (await request('/auth/me', owner.headers)).json() as { owner: boolean }).owner).toBe(false);
    expect(await (await request('/members/ownership', bearer(other.token), { revision: ownership.revision, ownerMemberId: owner.id })).json()).toMatchObject({ persisted: false, code: 'not_admin' });
    const invalid = await request('/api/ownership', admin.headers, { revision: ownership.revision, ownerMemberId: other.id });
    expect({ status: invalid.status, body: await invalid.json() }).toEqual({ status: 409, body: { error: 'invalid_owner' } });
    const bootstrapped = await request('/api/ownership', target.ownerHeaders(), { revision: ownership.revision, ownerMemberId: owner.id });
    expect(bootstrapped.status).toBe(200);
    expect((await bootstrapped.json() as DeploymentOwnershipPreview).ownerMemberId).toBe(owner.id);
    expect(await target.sql('SELECT member_id,actor_id FROM deployment_ownership_audit')).toEqual([{ member_id: owner.id, actor_id: MEMBER_ID }]);
    expect((await (await request('/auth/me', owner.headers)).json() as { owner: boolean }).owner).toBe(true);
    expect((await (await request('/auth/me', admin.headers)).json() as { owner: boolean }).owner).toBe(false);
    const replacement = await request('/api/ownership', admin.headers, { revision: ownership.revision, ownerMemberId: admin.id });
    expect({ status: replacement.status, body: await replacement.json() }).toEqual({ status: 409, body: { error: 'owner_already_recorded' } });

    const upload = async (projectId: string, token: string, text: string) => {
      const key = await sha256Hex(text);
      await expectPersisted(await fetch(`${target.url}/blobs/${key}`, { method: 'POST', headers: memberHeadersFor(token, projectId, { 'content-type': 'text/plain', 'content-length': String(utf8(text).byteLength) }), body: text }), 'raw claim fixture object');
      return { projectId, key, text };
    };
    const unknownA = await upload(PROJECTS[0], owner.token, 'historical unknown raw bytes A');
    const unknownB = await upload(PROJECTS[1], owner.token, 'historical unknown raw bytes B');
    const known = await upload(PROJECTS[0], other.token, 'known other member raw bytes');
    const missing = 'credential_missing_claim_history';
    await write([
      ...PROJECTS.map((projectId) => `INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES (${lit(projectId)},${lit(SESSION)},'machine_missing_claim_history',${lit(missing)},${oldest},${newest})`),
      ...[unknownA, unknownB].flatMap((blob) => [
        `UPDATE blobs SET token_id = ${lit(missing)}, received_at = ${oldest} WHERE project_id = ${lit(blob.projectId)} AND key = ${lit(blob.key)}`,
        `DELETE FROM raw_resources WHERE project_id = ${lit(blob.projectId)} AND kind = 'blob' AND resource_id = ${lit(blob.key)}`,
      ]),
      ...PROJECTS.map((projectId) => `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
        VALUES (${lit(projectId)},'unknown_transcript',${lit(SESSION)},'machine_missing_claim_history',0,0,${oldest},${newest},${lit(missing)})`),
      `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
        VALUES (${lit(PROJECTS[0])},'known_transcript',${lit(SESSION)},${lit(other.machine)},0,0,${oldest},${newest},${lit(other.tokenId)}),
        (${lit(PROJECTS[0])},'ambiguous_transcript',${lit(SESSION)},${lit(other.machine)},0,0,${oldest},${newest},${lit(owner.tokenId)})`,
      ...[{ id: 'own_partial', machine: owner.machine }, { id: 'foreign_partial', machine: other.machine }].flatMap((transcript) => [
        `INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id)
          VALUES (${lit(PROJECTS[0])},${lit(transcript.id)},${lit(SESSION)},${lit(transcript.machine)},1,1,${newest},${newest},'missing_header_claim')`,
        `INSERT INTO transcript_segments (project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
          VALUES (${lit(PROJECTS[0])},${lit(transcript.id)},0,1,${lit(unknownA.key)},${lit(`${transcript.id}_segment`)},${newest},${newest},${lit(missing)})`,
      ]),
      ...[
        { projectId: PROJECTS[0], id: 'unknown_event_old', tokenId: missing, at: oldest },
        { projectId: PROJECTS[0], id: 'unknown_event_new', tokenId: missing, at: newest },
        { projectId: PROJECTS[1], id: 'unknown_event_b', tokenId: missing, at: newest },
        { projectId: PROJECTS[0], id: 'known_event', tokenId: other.tokenId, at: newest },
      ].map((event) => `INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
        VALUES (${lit(event.projectId)},${lit(event.id)},${lit(SESSION)},${lit(event.tokenId)},'notification','cli',${lit(JSON.stringify({ message: event.id }))},'claim fixture',${event.at},${event.at})`),
      `UPDATE raw_provenance_backfill SET source = 0,cursor_project = '',cursor_id = '',complete = 0,updated_at = 0 WHERE id = 1`,
    ]);
    const pending = await (await request('/api/raw-claims', owner.headers)).json() as RawClaimPreview;
    expect(pending.complete).toBe(false);
    const held = await request('/api/raw-claims', owner.headers, { revision: pending.revision });
    expect({ status: held.status, body: await held.json() }).toEqual({ status: 409, body: { error: 'backfill_pending' } });
    for (let pass = 0; pass < MAX_BACKFILL_WAKES; pass += 1) {
      const wake = await request('/api/wake', target.ownerHeaders(), {});
      expect(wake.status).toBe(200);
      const body = await wake.json() as { jobs: Array<{ name: string; failed: string | null }> };
      expect(body.jobs.find((job) => job.name === 'raw-provenance-backfill')?.failed).toBeNull();
      if ((await (await request('/api/raw-claims', owner.headers)).json() as RawClaimPreview).complete) break;
    }
    const preview = await (await request('/api/raw-claims', owner.headers)).json() as RawClaimPreview;
    expect(preview.complete).toBe(true);
    expect(preview.projects).toEqual(PROJECTS.map((projectId, index) => ({ projectId, name: `Claim archive ${index + 1}`, kinds: [
      { kind: 'blob', count: 1, oldestAt: oldest, newestAt: oldest },
      { kind: 'event', count: index === 0 ? 2 : 1, oldestAt: index === 0 ? oldest : newest, newestAt: newest },
      { kind: 'transcript', count: index === 0 ? 2 : 1, oldestAt: oldest, newestAt: index === 0 ? newest : oldest },
    ] })));
    const blobRoute = (blob: { projectId: string; key: string }) => `/api/projects/${blob.projectId}/blobs/${blob.key}`;
    const transcriptRoute = `/api/projects/${PROJECTS[0]}/sessions/${SESSION}/transcript`;
    expect((await request(blobRoute(unknownA), owner.headers)).status).toBe(404);
    for (const denied of [admin, other]) {
      expect((await request('/api/raw-claims', denied.headers)).status).toBe(403);
      expect(await (await request('/members/raw-claims', bearer(denied.token), { revision: preview.revision })).json()).toMatchObject({ persisted: false, code: 'not_owner' });
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), `myco-claim-cli-${target.name}-`));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const preload = path.join(root, 'cloudflare-source.ts');
      if (target.name === 'cloudflare') {
        // Local workerd requires the source header Cloudflare adds to production requests.
        fs.writeFileSync(preload, `const networkFetch = globalThis.fetch;\nglobalThis.fetch = (input, init) => { const request = new Request(input, init); if (new URL(request.url).origin === new URL(process.env.MYCO_SERVER_URL!).origin) request.headers.set('cf-connecting-ip', '1.2.3.4'); return networkFetch(request); };\n`);
      }
      const cli = async (op: 'ownership' | 'raw-claims', args: string[], token = owner.token) => {
        const env = { ...process.env, HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), MYCO_HOME: path.join(root, 'myco'), MYCO_SERVER_URL: target.url, MYCO_MEMBER_TOKEN: token };
        delete (env as NodeJS.ProcessEnv).MYCO_PROJECT;
        const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const argv = [...(target.name === 'cloudflare' ? ['--preload', preload] : []), path.resolve('packages/myco/src/cli.ts'), 'member', op, '--credential', 'env', ...args];
          const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => child.kill('SIGTERM'), CLI_TIMEOUT_MS);
          child.stdout.on('data', (chunk) => { stdout += String(chunk); });
          child.stderr.on('data', (chunk) => { stderr += String(chunk); });
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
        });
        expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
        return result;
      };
      const ownershipCli = await cli('ownership', []);
      expect(ownershipCli.status).toBe(0);
      const currentOwnership = JSON.parse(ownershipCli.stdout) as DeploymentOwnershipPreview;
      expect(currentOwnership.ownerMemberId).toBe(owner.id);
      const repeatedOwner = await cli('ownership', ['--owner', owner.id, '--revision', currentOwnership.revision], target.memberToken);
      expect(repeatedOwner.status).toBe(0);
      expect(await target.sql('SELECT COUNT(*) AS n FROM deployment_ownership_audit')).toEqual([{ n: 1 }]);
      const cliPreview = await cli('raw-claims', []);
      expect(cliPreview.status).toBe(0);
      expect(JSON.parse(cliPreview.stdout)).toMatchObject(preview);
      expect((await cli('raw-claims', ['--apply', '--revision', '0'])).status).toBe(2);
      expect(await target.sql('SELECT COUNT(*) AS n FROM raw_claims')).toEqual([{ n: 0 }]);
      expect((await cli('raw-claims', ['--apply', '--revision', preview.revision], admin.token)).status).toBe(2);
      const applied = await cli('raw-claims', ['--apply', '--revision', preview.revision]);
      expect(applied.status).toBe(0);
      expect(applied.stdout).toContain('"claimId"');
      expect(await target.sql('SELECT owner_member_id FROM raw_claims')).toEqual([{ owner_member_id: owner.id }]);
      const replay = await request('/api/raw-claims', owner.headers, { revision: preview.revision });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ claimId: null, preview: { complete: true, projects: [] } });
      expect(await target.sql('SELECT COUNT(*) AS n FROM raw_claims')).toEqual([{ n: 1 }]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }

    for (const blob of [unknownA, unknownB]) {
      const admitted = await request(blobRoute(blob), owner.headers);
      expect(admitted.status).toBe(200);
      expect(await admitted.text()).toBe(blob.text);
      expect(admitted.headers.get('cache-control')).toBe('private, no-store');
      for (const denied of [admin, other]) expect((await request(blobRoute(blob), denied.headers)).status).toBe(404);
    }
    const otherRead = await request(blobRoute(known), other.headers);
    expect(otherRead.status).toBe(200);
    expect(await otherRead.text()).toBe(known.text);
    expect((await request(blobRoute(known), owner.headers)).status).toBe(404);
    const transcripts = await request(transcriptRoute, owner.headers);
    expect(transcripts.status).toBe(200);
    expect((await transcripts.json() as { transcripts: Array<{ transcriptId: string }> }).transcripts.map((row) => row.transcriptId).sort()).toEqual(['own_partial', 'unknown_transcript']);
    const otherTranscripts = await request(transcriptRoute, other.headers);
    expect((await otherTranscripts.json() as { transcripts: Array<{ transcriptId: string }> }).transcripts.map((row) => row.transcriptId)).toEqual(['known_transcript']);
    await target.sql(`INSERT INTO events (project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES (${lit(PROJECTS[0])},'unknown_after_claim',${lit(SESSION)},${lit(missing)},'notification','cli','{}','later claim fixture',${now},${now})`);
    const later = await (await request('/api/raw-claims', owner.headers)).json() as RawClaimPreview;
    expect(later.projects).toEqual([{ projectId: PROJECTS[0], name: 'Claim archive 1', kinds: [{ kind: 'event', count: 1, oldestAt: now, newestAt: now }] }]);
    const outdated = await request('/api/raw-claims', owner.headers, { revision: preview.revision });
    expect({ status: outdated.status, body: await outdated.json() }).toEqual({ status: 409, body: { error: 'revision_conflict' } });
    expect(await target.sql('SELECT COUNT(*) AS n FROM raw_claims')).toEqual([{ n: 1 }]);
    await upload(unknownA.projectId, other.token, unknownA.text);
    for (const admitted of [owner, other]) {
      const shared = await request(blobRoute(unknownA), admitted.headers);
      expect(shared.status).toBe(200);
      expect(await shared.text()).toBe(unknownA.text);
      expect(shared.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await request(blobRoute(unknownA), admin.headers)).status).toBe(404);
    expect(await target.sql('SELECT COUNT(*) AS n FROM raw_claims')).toEqual([{ n: 1 }]);
  },
};
