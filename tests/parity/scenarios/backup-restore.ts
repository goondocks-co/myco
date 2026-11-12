import { expect } from 'bun:test';
import { FOREIGN_LINEAGE_REVOKER } from '@myco-server-worker/constants.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { SESSION_SECRET, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { selectOwner, credentials } from '../clients/identity.ts';
import { owner, event, mcp } from '../clients/requests.ts';
import { linkedMember } from '../clients/runs.ts';
import { bootSelfhosted } from '../targets/selfhosted.ts';

// State-changing owner routes hold a same-origin line; a scenario names its own origin the way a browser would.
const ownerJson = (target: ParityTarget) => ({ ...target.ownerHeaders(), 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', origin: target.url });

async function ownerPost<T>(target: ParityTarget, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${target.url}${path}`, { method: 'POST', headers: ownerJson(target), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/**
 * The backup story on one target, then across targets: create, list verified,
 * preview, additive restore that converges, and an artifact carried to a
 * SIBLING deployment — refused as foreign until deliberately adopted.
 */
export const backupRestore: ParityScenario = {
  name: 'backup: create, verified list, preview, converging restore, and cross-deployment adoption',
  dedicated: { timeoutMs: 300_000 },
  async run(target) {
    await selectOwner(target);
    await event(target, 'sess_backup', 'session.start', { agent: 'claude-code', startedAt: Date.now() });

    const spore = await mcp(target, 'myco_spores', { op: 'save', type: 'gotcha', content: 'kept in the backup', agent_line: 'Keep backup history.' });
    const created = await ownerPost<{ backup: { id: string } }>(target, '/api/backups', {});
    expect(created.status).toBe(200);
    const id = created.body.backup.id;

    const listed = await fetch(`${target.url}/api/backups`, { headers: ownerJson(target) });
    const list = (await listed.json()) as { backups: Array<{ id: string; verification: { state: string } }> };
    expect(list.backups.find((b) => b.id === id)?.verification.state).toBe('verified');
    const verified = await ownerPost<{ verification: { state: string } }>(target, `/api/backups/${id}/verify`, {});
    expect({ status: verified.status, state: verified.body.verification.state }).toEqual({ status: 200, state: 'verified' });

    const preview = await ownerPost<{ foreignLineage: boolean; header: { counts: Record<string, number> } }>(target, `/api/backups/${id}/restore-preview`, {});
    expect({ status: preview.status, foreign: preview.body.foreignLineage }).toEqual({ status: 200, foreign: false });
    expect(preview.body.header.counts.sessions).toBeGreaterThanOrEqual(1);

    const restored = await ownerPost<{ applied: boolean; tables: Record<string, { inserted: number }> }>(target, `/api/backups/${id}/restore`, {});
    expect({ status: restored.status, applied: restored.body.applied }).toEqual({ status: 200, applied: true });
    const again = await ownerPost<{ tables: Record<string, { inserted: number }> }>(target, `/api/backups/${id}/restore`, {});
    expect(Object.values(again.body.tables).every((t) => t.inserted === 0)).toBe(true);

    // Across deployments: the artifact travels; a sibling refuses it as foreign until adopted.
    const artifact = await fetch(`${target.url}/api/backups/${id}/artifact`, { headers: ownerJson(target) });
    expect(artifact.status).toBe(200);
    const text = await artifact.text();
    const backedUp = text.trim().split('\n').map(line => JSON.parse(line));
    expect(backedUp.find(row => row.t === 'spores' && row.r.id === spore.id)?.r.content).toBe('kept in the backup');
    const sibling = await bootSelfhosted();
    try {
      await selectOwner(sibling);
      const refused = await ownerPost<{ error: string }>(sibling, '/api/backups/restore-upload', { artifact: text });
      expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 409, error: 'foreign_lineage' });

      // A backup carries no blob bytes. An artifact registering blobs the sibling does not hold is refused whole before any
      // row is written; one registering none is adopted.
      const registersBlobs = text.split('\n').some((line) => line.startsWith('{"t":"blobs"'));
      const adopted = await ownerPost<{ applied?: boolean; error?: string }>(sibling, '/api/backups/restore-upload', { artifact: text, allowForeignLineage: true });
      const session = await owner(sibling, `/api/projects/${sibling.projectId}/sessions/sess_backup`);
      if (registersBlobs) {
        expect({ status: adopted.status, error: adopted.body.error, sessions: session.status }).toEqual({ status: 409, error: 'objects_missing', sessions: 404 });
      } else {
        expect({ status: adopted.status, applied: adopted.body.applied, sessions: session.status }).toEqual({ status: 200, applied: true, sessions: 200 });
      }

      // The reverse direction: the sibling's own backup lands here under the same adoption rule. The sibling's live
      // member credential and External Agent grant land revoked, and its GitHub-linked admin lands held: none of them
      // acts here until this server's owner re-admits the admin.
      const joinedAdmin = await linkedMember(sibling, '970001');
      const heldAdmin = joinedAdmin.memberId;
      expect((await owner(sibling, `/api/members/${heldAdmin}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin', expected_revision: '0' }) })).status).toBe(200);
      const signedIn = async (on: ParityTarget) => ({ cookie: `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: on.deploymentId, sub: '970001', login: 'sibling-admin', iat: Date.now(), exp: Date.now() + 3_600_000 })}`,
        'cf-connecting-ip': '1.2.3.4', origin: on.url, 'content-type': 'application/json' });
      const adminRead = async (on: ParityTarget) => (await fetch(`${on.url}/api/members`, { headers: await signedIn(on) })).status;
      const adminWrite = async (on: ParityTarget) => (await fetch(`${on.url}/api/projects/${on.projectId}/grants`, { method: 'POST', headers: await signedIn(on), body: JSON.stringify({ label: 'held admin' }) })).status;
      expect({ sibling: await adminRead(sibling), target: await adminRead(target) }).toEqual({ sibling: 200, target: 401 });
      const minted = await ownerPost<{ key: string; id: string }>(sibling, `/api/projects/${sibling.projectId}/grants`, { label: 'sibling grant' });
      expect(minted.status).toBe(201);
      const siblingAuthority = (await credentials(sibling)).filter(row => row.live).map(row => String(row.id));
      const memberRead = (on: ParityTarget) => fetch(`${on.url}/members/status`, { method: 'POST',
        headers: { ...memberHeadersFor(sibling.memberToken, on.projectId), 'content-type': 'application/json' }, body: '{}' });
      const grantList = (on: ParityTarget) => fetch(`${on.url}/mcp`, { method: 'POST',
        headers: { ...on.grantHeaders(minted.body.key), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect({ member: (await memberRead(sibling)).status, grant: (await grantList(sibling)).status }).toEqual({ member: 200, grant: 200 });
      const siblingBackup = await ownerPost<{ backup: { id: string } }>(sibling, '/api/backups', {});
      const siblingArtifact = await fetch(`${sibling.url}/api/backups/${siblingBackup.body.backup.id}/artifact`, { headers: ownerJson(sibling) });
      const back = await ownerPost<{ applied: boolean }>(target, '/api/backups/restore-upload', { artifact: await siblingArtifact.text(), allowForeignLineage: true });
      expect({ status: back.status, applied: back.body.applied }).toEqual({ status: 200, applied: true });
      const landed = await credentials(target);
      const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      expect(landed.filter(row => siblingAuthority.includes(row.id)).map(row => ({ id: row.id, live: row.live, revokedBy: row.revokedBy })).sort(byId))
        .toEqual(siblingAuthority.map(id => ({ id, live: false, revokedBy: FOREIGN_LINEAGE_REVOKER })).sort(byId));
      expect({ member: (await memberRead(target)).status, grant: (await grantList(target)).status }).toEqual({ member: 401, grant: 401 });
      expect({ read: await adminRead(target), write: await adminWrite(target) }).toEqual({ read: 401, write: 401 });
      const members = (await owner(target, '/api/members')).body.members;
      const held = members.find((row: any) => row.id === heldAdmin);
      expect(held).toMatchObject({ role: 'admin', revokedBy: FOREIGN_LINEAGE_REVOKER });
      const revision = String(held.roleRevision);
      const readmitted = await ownerPost<{ role: string }>(target, `/api/members/${heldAdmin}/role`, { role: 'admin', expected_revision: revision });
      expect({ status: readmitted.status, role: readmitted.body.role }).toEqual({ status: 200, role: 'admin' });
      expect({ read: await adminRead(target), write: await adminWrite(target) }).toEqual({ read: 200, write: 201 });
    } finally {
      await sibling.stop();
    }
  },
};
