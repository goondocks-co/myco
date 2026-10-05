import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';

/** Retained publication and pin routes wait across execution-time authority loss. */
export async function runControlWait(env: ServerEnv) {
  const { db } = env;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','test',0)"),
    db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)"),
    db.prepare("INSERT INTO project_repositories(project_id,revision,url,branch,updated_at,updated_by) VALUES('proj_1','r','https://example.test/source','main',0,'test')"),
  ]);
  await ensureMember(db, HARNESS_MEMBER_ID, Date.now(), 'member', 'harness');
  const server = createServer({ now: Date.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
  const repository = { url: 'https://example.test/source', branch: 'main', commit: 'a'.repeat(40) };
  const source = { inputHash: 'b'.repeat(64), priorRevision: null };
  const file = { path: 'src/a.ts', annotation: 'Entry', groundedIn: [{ path: 'src/a.ts', sha256: 'c'.repeat(64) }] };
  const artifact = { directories: [{ ...file, path: 'src' }], domains: [{ id: 'main', title: 'Main', files: [file] }] };
  const answers = [];
  for (const op of ['publication', 'map_pin', 'repository_pin']) for (const bound of ['attempt', 'credential', 'revocation']) {
    const now = Date.now(), id = `${op}_${bound}`;
    const holder = await issueMemberToken(db, { memberId: HARNESS_MEMBER_ID, machineId: 'machine_1' }, now);
    await recordDispatch(db, { projectId: 'proj_1' }, { id, agentId: 'myco-agent', task: 'canopy-map', provider: null, model: null,
      runContext: JSON.stringify({ timeoutSeconds: 300, ...(op === 'repository_pin' ? {} : { repository }), ...(op === 'publication' ? { canopy: source } : {}) }),
      startedAt: now, dispatchedBy: holder.tokenId });
    await db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').bind('running', id).run();
    const expiry = Date.now() + 150;
    if (bound === 'attempt') await db.prepare('UPDATE agent_runs SET started_at = ? WHERE id = ?').bind(expiry - 420_000, id).run();
    if (bound === 'credential') await db.prepare('UPDATE member_credentials SET expires_at = ? WHERE id = ?').bind(expiry, holder.tokenId).run();
    const delayed = { ...env, db: { prepare: db.prepare.bind(db), batch: async (statements: Parameters<typeof db.batch>[0]) => {
      await new Promise(resolve => setTimeout(resolve, 220));
      if (bound === 'revocation') await db.prepare('UPDATE member_credentials SET revoked_at = 1 WHERE id = ?').bind(holder.tokenId).run();
      return db.batch(statements);
    } } };
    const path = op === 'repository_pin' ? '/runs/repository' : '/runs/canopy-map';
    const offer = op === 'repository_pin' ? { runId: id, ...repository } : { runId: id, op: op === 'map_pin' ? 'pin' : 'write', source, artifact };
    const res = await server.handleRequest(new Request(`https://s${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${holder.token}`, [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) }, body: JSON.stringify(offer) }), delayed);
    const body = await res.json() as { persisted?: boolean; code?: string };
    const row = await db.prepare('SELECT run_context AS context FROM agent_runs WHERE id = ?').bind(id).first<{ context: string }>();
    const maps = await db.prepare('SELECT COUNT(*) AS n FROM canopy_maps').first<{ n: number }>();
    const pinned = JSON.parse(row!.context)[op === 'repository_pin' ? 'repository' : 'canopy'];
    answers.push({ op, bound, code: body.code, refused: body.persisted === false, maps: maps!.n, pinned: pinned !== undefined && op !== 'publication' });
  }
  return answers;
}
