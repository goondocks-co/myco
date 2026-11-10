import type { SearchOptions } from '@goondocks/myco-shared/search-types';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { searchAcross, searchDeployment } from '@myco-server-worker/core/search.js';
import { reconcileSearchIndex } from '@myco-server-worker/core/search-index.js';
import { searchBlobsDue } from '@myco-server-worker/db/search/blob-index.js';
import { registerBlob } from './d1.js';
import { sqliteEnv } from './fixtures.js';

type Row = Record<string, string | number | null>;

/**
 * A Deployment holding records a search finds, written as capture writes them: sessions, spores, plans (inline, or with
 * a body stored apart and proved processed) and conversation cards. `search` asks as a member of the dashboard would.
 */
export function searchFixture(projects: readonly string[] = ['search-a', 'search-b']) {
  const f = sqliteEnv();
  const insert = (table: string, row: Row) =>
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  insert('agents', { id: 'search-agent', name: 'search', source: 'built-in', enabled: 1, created_at: 1 });
  const session = (id: string, over: Row = {}, project = projects[0]!) =>
    insert('sessions', { project_id: project, session_id: id, machine_id: 'm', created_by_token_id: 't', first_received_at: 1000, last_received_at: 1000, ...over });
  /** Every Project holds an untitled session `ps`, the one a plan belongs to unless it names another. */
  for (const project of projects) {
    insert('projects', { project_id: project, name: project, created_at: 1 });
    session('ps', {}, project);
  }
  const spore = (id: string, content: string, over: Row = {}, project = projects[0]!) =>
    insert('spores', { project_id: project, id, agent_id: 'search-agent', observation_type: 'gotcha', status: 'active', content, created_at: 1000, ...over });
  const card = (session: string, turn: string, text: string, over: Row = {}, project = projects[0]!) =>
    insert('turn_cards', { project_id: project, session_id: session, turn_key: turn, state: 'carded', card: text, created_at: 1000, ...over });
  const plan = (key: string, content: string | null, over: Row = {}, project = projects[0]!) =>
    insert('plans', { project_id: project, plan_key: key, session_id: 'ps', event_id: 'e', machine_id: 'm', token_id: 't', status: 'active', title: 'a plan', content, content_hash: 'h',
      created_at: 1000, updated_at: 1000, received_at: 1000, ...over });
  /** A blob of `text` registered in the Project, its bytes in the store; answers the stored object's key. */
  const blob = async (key: string, text: string, project = projects[0]!, receivedAt = 1000) => {
    const bytes = new TextEncoder().encode(text);
    const objectKey = registerBlob(f.sqlite, { projectId: project, key, size: bytes.length, tokenId: 't', receivedAt });
    await f.bucket.put(objectKey, new Response(bytes).body);
    return objectKey;
  };
  /**
   * A plan whose body is stored apart in blob `key`. Capture proves a registered body processed as it writes the plan;
   * `proved: false` leaves it as a body not yet proved, with no proof.
   */
  const spilledPlan = (planKey: string, key: string, options: { proved?: boolean; over?: Row; project?: string } = {}) => {
    const project = options.project ?? projects[0]!;
    plan(planKey, null, { blob_key: key, ...options.over }, project);
    if (options.proved === false) f.sqlite.prepare("DELETE FROM processed_resources WHERE project_id = ? AND kind = 'plan' AND resource_id = ?").run(project, planKey);
    else prove(planKey, key, project);
  };
  const prove = (planKey: string, key: string, project = projects[0]!) =>
    f.sqlite.prepare(`INSERT OR IGNORE INTO processed_resources (project_id, kind, resource_id, blob_key, source_token_id, event_id) VALUES (?, 'plan', ?, ?, 't', 'e')`).run(project, planKey, key);
  /** Runs index passes until no blob is due, or `limit` passes. */
  const index = async (now = Date.now(), limit = 50) => {
    for (let pass = 0; pass < limit && await searchBlobsDue(f.db, now); pass += 1) await reconcileSearchIndex(f.db, f.bucket, now);
  };
  const search = (query: string, options: Omit<SearchOptions, 'query'> = {}, reader = 'member:test', project = projects[0]!) =>
    searchDeployment(f.serverEnv, { projectId: project }, { query, ...options }, reader);
  const across = (query: string, options: Omit<SearchOptions, 'query'> = {}, named: readonly string[] | null = null, reader = 'member:test') =>
    searchAcross(f.serverEnv, named === null ? { all: true } : { all: false, projectIds: named }, { query, ...options }, reader);
  return { ...f, insert, session, spore, card, plan, blob, spilledPlan, prove, index, search, across };
}

export type SearchFixture = ReturnType<typeof searchFixture>;

/** A word search of one Project as a member asks it, over a store alone: no semantic provider, no stored bodies. */
export const searchWords = (db: RelationalStore, scope: { projectId: string }, options: SearchOptions) =>
  searchDeployment({ db } as unknown as ServerEnv, scope, options, 'member:test');
