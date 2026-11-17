import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { createServer } from '@myco-server-worker/pipeline.js';
import { memberHeaders } from './fixtures.js';
import { budgetFixture } from './budget-fixture.js';
import { offeredHarness } from './offered-harness.js';
import { indexFixture } from './vector-index.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { vectorId } from '@myco-server-worker/core/embedding/vectors.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { runToolContext } from '@myco-server-worker/mcp/context.js';
import { discoverSporeClusters } from '@myco-server-worker/core/spore-curation.js';
import { type ToolDefinition } from '@myco-server-worker/mcp/definitions.js';

export async function curationFixture(deferred = false) {
  const f = await budgetFixture();
  const index = indexFixture({deferred:true});
  const vectors = cloudflareVectorStore(index);
  const calls = { get: 0, query: 0, embed: 0 };
  const visits: string[] = [];
  const get = vectors.get.bind(vectors), query = vectors.query.bind(vectors);
  vectors.get = async (...args) => { calls.get++; const found=await get(...args); visits.push(...found.map(row=>row.metadata.record_id)); return found; };
  vectors.query = (...args) => { calls.query++; return query(...args); };
  const env = { ...f.serverEnv, vectors, embeddingProvider: async () => ({ modelKey: 'curation-fixture', embed: async (query: string): Promise<number[]> => { calls.embed++; return query==='other-topic'?[0,1]:[1,0]; } }) };
  const enable = () => settingsWriter(f.db).setCapability('proj_1', 'spore_curation', true, 'test', f.now - 10);
  const add = async (id: string, values = [1, 0], created = f.now, content = `Whole content for ${id}`, stats: {mean:number;std:number}|null = {mean:0.4,std:0.04}) => {
    f.sqlite.run(`INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,agent_line,created_at)
      VALUES('proj_1',?,'myco-agent',?,'decision','Use the named seam.',?)`, [id, content, created]);
    const source = f.sqlite.query<{ revision: string }, [string]>("SELECT revision FROM embedding_versions WHERE project_id='proj_1' AND type='spore' AND record_id=?").get(id)!;
    const partition = { projectId: 'proj_1', modelKey: 'curation-fixture' };
    const key = await vectorId(partition, 'spore', id, source.revision);
    await vectors.upsert(partition, [{ id: key, values, metadata: { type: 'spore', record_id: id, revision: source.revision, status: 'active', session_id: '', created_at: created, observation_type: 'decision', release_state: '', release_confidence: '' } }]);
    if(!deferred) index.apply();
    f.sqlite.run(`INSERT OR REPLACE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at,neighbor_mean,neighbor_std)
      VALUES('proj_1','curation-fixture',?,'spore',?,?,1,?,?,?)`, [key, id, source.revision, f.now,stats?.mean??null,stats?.std??null]);
  };
  const discover = async () => { for (let i=0; i<4; i++) await discoverSporeClusters(env, f.now); };
  const poll = (now = f.now) => claimNextRun(env, { principal: f.principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
  const ctx = async (runId: string, tokenId: string) => runToolContext(env, { projectId: 'proj_1', run: { ...(await getRun(f.db, { projectId: 'proj_1' }, runId))!, projectId: 'proj_1' }, tokenId, now: f.now, body: '' });
  const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
  const request = async (token: string, method: string, params?: unknown) => {
    const response = await server.handleRequest(new Request('https://fixture.test/mcp', { method: 'POST', headers: memberHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env);
    const body = await response.json() as { error?: unknown; result?: { content?: { text?: string }[]; tools?: ToolDefinition[] } };
    if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  const call = async (token: string, name: string, args: Record<string,unknown>) =>
    JSON.parse((await request(token,'tools/call',{name,arguments:{project:'proj_1',...args}}))?.content?.[0]?.text ?? '{}') as unknown;
  const list = async (token: string) => (await request(token,'tools/list'))!.tools!;

  return { ...f, env, enable, add, discover, poll, ctx, call, list, calls, visits, applyVectors:()=>index.apply() };
}

export const keepAnswer = (ids: string[]) => ({ op: 'answer', notes: [], keep: ids, retire: [], reason: 'Distinct situations.' });
export const note = (sources: string[], content = 'When delivery stalls, retain queued capture.') =>
  ({ sources, observation_type: 'gotcha', agent_line: 'When delivery stalls, retain queued capture.', content });
export const scope = {projectId:'proj_1'};
