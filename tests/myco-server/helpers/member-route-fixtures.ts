import type { Database } from 'bun:sqlite';
import type { Shape } from '@myco-server-worker/routes.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { envelope as envelopeFields, memberHeaders } from './fixtures.js';

/** A member route's two fixture requests: one the route refuses as malformed, and one well formed that it would act on. */
export interface MemberRouteFixture { shape: Shape; malformed: (token: string) => Request; wellFormed: (token: string) => Request }

const envelope = (over: Record<string, unknown> = {}) => JSON.stringify(envelopeFields(over));

/**
 * Seeds what every member route's well-formed request needs on a fresh Deployment (a claimed machine, a project with
 * its capability, an agent, two running runs) and answers each member route's fixture requests, keyed `METHOD /path`.
 * `otherTokenId` is a credential a malformed revoke names; `machinelessToken` is a credential with no machine identity.
 */
export async function memberRouteFixtures(sqlite: Database, issuedAt: number, peers: { otherTokenId: string; machinelessToken: string }): Promise<Record<string, MemberRouteFixture>> {
  sqlite.run("INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)", [issuedAt]);
  // A fresh Deployment: no admin has a GitHub account linked, so a member credential is answered a link key.
  sqlite.query(`UPDATE members SET github_id = NULL`).run();
  const KEY = 'a'.repeat(64);
  // The run routes reference an agent identity and a project, both of which a
  // Deployment declares before any run is claimed.
  let runSeq = 0;
  sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(issuedAt);
  sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_gate', 'gate', 'built-in', 1, ?)`).run(issuedAt);
  sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'gate')`).run(issuedAt);
  const bytes = new TextEncoder().encode('blob-bytes');
  const key = await sha256Hex('blob-bytes');
  // One run the write fixtures may report against: a report on an unknown run
  // is refused, and a fixture must be a single accepted request.
  sqlite.query(`INSERT OR IGNORE INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'run_gate', 'user', 'gate', 'running', 1)`).run();
  sqlite.query(`INSERT OR IGNORE INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'run_gate_report', 'user', 'embedding-reconcile', 'running', 1)`).run();

  return {
    'POST /events': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/events', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/events', { method: 'POST', headers: memberHeaders(token), body: envelope() }),
    },
    'POST /blobs/{sha256}': {
      shape: 'stored',
      malformed: (token) => new Request(`https://s/blobs/${KEY}`, { method: 'POST', headers: memberHeaders(token, { 'content-type': 'nonsense', 'content-length': '2' }), body: '{}' }),
      wellFormed: (token) => new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(token, { 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes }),
    },
    'POST /tokens/refresh': {
      shape: 'refreshed',
      malformed: (token) => new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
    'POST /members/credential/revoke': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/credential/revoke', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ tokenId: peers.otherTokenId }) }),
      wellFormed: (token) => new Request('https://s/members/credential/revoke', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
    // #1148 — the import plan. Advice, not an authority: it stores nothing,
    // so a malformed ask is refused in the same shape as any other.
    'POST /import/plan': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/import/plan', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/import/plan', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ candidates: [] }) }),
    },
    'POST /import/legacy-history': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/import/legacy-history', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/import/legacy-history', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ eventGroups: [[crypto.randomUUID()]] }) }),
    },
    'POST /runs/claim': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/runs/claim', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/runs/claim', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ id: `run_${runSeq++}`, agentId: 'agent_gate', task: `digest_${runSeq}`, capability: 'cortex' }) }),
    },

    'POST /runs/update': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/runs/update', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/runs/update', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'nope', update: { status: 'failed' } }) }),
    },




    'POST /runs/report': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/runs/report', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/runs/report', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'run_gate_report', agentId: 'user', action: 'embedding-reconcile', summary: 's' }) }),
    },

    'POST /runs/embedding-step': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/runs/embedding-step', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/runs/embedding-step', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'run_gate' }) }),
    },
    'POST /spores/save': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/spores/save', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/spores/save', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ id: `sp_${runSeq++}`, agentId: 'agent_gate', observationType: 'gotcha', content: 'c', agentLine: 'When using this fixture, retain its evidence.' }) }),
    },
    'POST /spores/list': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/spores/list', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/spores/list', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
    'POST /spores/get': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/spores/get', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/spores/get', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ id: 'nope' }) }),
    },
    'POST /spores/resolve': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/spores/resolve', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/spores/resolve', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ eventId: `re_${runSeq++}`, agentId: 'agent_gate', sporeId: 'nope', action: 'obsolete', reason: 'retire fixture', status: 'obsolete' }) }),
    },
    'POST /context/prompt': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ sessionId: `s_gate_${runSeq++}`, promptId: 'p_gate', text: 'what did we settle on' }) }),
    },
    'POST /context/session': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/context/session', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/context/session', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ sessionId: `s_gate_${runSeq++}`, kind: 'start' }) }),
    },


    'POST /worker/claim': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/worker/claim', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/worker/claim', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ harnesses: [] }) }),
    },
    'POST /worker/lease': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/worker/lease', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/worker/lease', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_absent' }) }),
    },
    'POST /worker/end': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/worker/end', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/worker/end', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_absent', status: 'failed' }) }),
    },
    'POST /worker/steps': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/worker/steps', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/worker/steps', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_absent', attemptId: 'mt_absent', page: 0, pages: 1, total: 0, overflow: 0, unrecognized: { total: 0, shapes: {} }, steps: [] }) }),
    },
    'POST /worker/repository': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/worker/repository', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/worker/repository', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_absent' }) }),
    },
    'POST /worker/models': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/worker/models', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/worker/models', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ catalog: { observedOrder: 1, harness: 'codex', source: { kind: 'exchange', command: 'codex app-server' }, signIn: 'worker-login', fetchedAt: 1, models: [] } }) }),
    },
    'POST /mcp': {
      shape: 'answered',
      malformed: (token) => new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
    },
    'POST /members/link-github': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
      wellFormed: (token) => new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
    'POST /members/projects': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/projects', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ name: '' }) }),
      wellFormed: (token) => new Request('https://s/members/projects', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ name: 'gate project' }) }),
    },
    'POST /members/projects/resolve': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/projects/resolve', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ rootKey: 'nope', label: 'repo' }) }),
      wellFormed: (token) => new Request('https://s/members/projects/resolve', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ rootKey: 'a'.repeat(16), label: 'gate-repo', remote: 'git@github.com:acme/gate.git' }) }),
    },
    'POST /members/uncaptured': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/uncaptured', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ rootKey: 'a'.repeat(16), label: 'repo', reason: 'bogus' }) }),
      wellFormed: (token) => new Request('https://s/members/uncaptured', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ rootKey: 'a'.repeat(16), label: 'gate-repo', reason: 'outside_folders' }) }),
    },
    'POST /members/uncaptured/state': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/uncaptured/state', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ rootKey: 'a'.repeat(16), state: 'bogus' }) }),
      wellFormed: (token) => new Request('https://s/members/uncaptured/state', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ rootKey: 'a'.repeat(16), state: 'connected' }) }),
    },
    'POST /members/harnesses/report': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/harnesses/report', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ harnesses: [{ id: 'codex', provisioned: true, state: 'binary_missing' }] }) }),
      wellFormed: (token) => new Request('https://s/members/harnesses/report', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ harnesses: [{ id: 'codex', provisioned: true, state: 'ready' }] }) }),
    },
    'GET /members/ownership': {
      shape: 'persisted',
      malformed: (_token) => new Request('https://s/members/ownership', { headers: memberHeaders(peers.machinelessToken) }),
      wellFormed: (token) => new Request('https://s/members/ownership', { headers: memberHeaders(token) }),
    },
    'POST /members/ownership': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/ownership', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/members/ownership', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ ownerMemberId: 'mem_machine_1', revision: '0' }) }),
    },
    'GET /members/roles': {
      shape: 'persisted',
      malformed: (_token) => new Request('https://s/members/roles', { headers: memberHeaders(peers.machinelessToken) }),
      wellFormed: (token) => new Request('https://s/members/roles', { headers: memberHeaders(token) }),
    },
    'POST /members/roles': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/roles', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/members/roles', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ member_id: 'mem_machine_3', role: 'member', expected_revision: '0' }) }),
    },
    'POST /members/ownership/transfer': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/ownership/transfer', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/members/ownership/transfer', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ member_id: 'mem_machine_2', expected_revision: '1' }) }),
    },
    'GET /members/raw-claims': {
      shape: 'persisted',
      malformed: (_token) => new Request('https://s/members/raw-claims', { headers: memberHeaders(peers.machinelessToken) }),
      wellFormed: (token) => new Request('https://s/members/raw-claims', { headers: memberHeaders(token) }),
    },
    'POST /members/raw-claims': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/raw-claims', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      wellFormed: (token) => new Request('https://s/members/raw-claims', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ revision: String((sqlite.query('SELECT revision FROM raw_provenance_state').get() as { revision: number }).revision) }) }),
    },
    'POST /members/projects/list': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/projects/list', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ project: 'x' }) }),
      wellFormed: (token) => new Request('https://s/members/projects/list', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
    'POST /members/settings': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/settings', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ leaf: 'x' }) }),
      wellFormed: (token) => new Request('https://s/members/settings', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
    'POST /members/status': {
      shape: 'persisted',
      malformed: (token) => new Request('https://s/members/status', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ project: 'x' }) }),
      wellFormed: (token) => new Request('https://s/members/status', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
    },
  };
}
