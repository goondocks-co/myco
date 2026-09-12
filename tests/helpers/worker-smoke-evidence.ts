import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';

const PAGE_SIZE = 100;
const MAX_SPORE_PAGES = 100;
const ACTIONS: Record<string, string> = { 'title-summary': 'summary', 'extract-curate': 'extract', 'vault-seed': 'seed' };

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object from the Deployment');
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value), 'Expected rows from the Deployment');
  return value.map(object);
}

/** Verify persisted outcomes through the same project-scoped MCP tools a member reads. */
export async function verifyWorkerOutcome(client: Client, project: string, runId: string) {
  async function read(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await client.callTool({ name, arguments: { ...args, project } });
    assert.notEqual(response.isError, true, `${name} failed`);
    const result = object(object(response.structuredContent).result);
    assert.notEqual(result.ok, false, `${name} refused the read`);
    return result;
  }

  const detail = object((await read('myco_agent', { op: 'run', id: runId })).data);
  const run = object(detail.run);
  assert.equal(run.id, runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.dry_run, false, 'A dry run does not prove artifact writes');
  const task = String(run.task);
  assert(Object.hasOwn(ACTIONS, task), `The smoke has no outcome check for ${task}`);
  const reports = rows(detail.reports).filter((report) => report.action === ACTIONS[task] || report.action === 'skip');
  assert(reports.length > 0, 'The run left no task report');
  for (const report of reports) {
    assert.equal(report.run_id, runId);
    assert(typeof report.summary === 'string' && report.summary.trim().length > 0, 'The report explains the outcome');
  }
  const skipped = reports.every((report) => report.action === 'skip');
  const evidence = object(detail.outcome_evidence);
  assert.equal(evidence.has_report, true);
  assert.equal(skipped ? evidence.skip_supported : evidence.artifact_present, true,
    skipped ? 'The stored state does not support this no-op' : 'The run left no task artifact');

  let title: string | null = null;
  if (task === 'title-summary') {
    assert(typeof evidence.target_session_id === 'string');
    const session = await read('myco_sessions', { op: 'get', id: evidence.target_session_id });
    assert.equal(session.id, evidence.target_session_id);
    assert(typeof session.title === 'string' && session.title.trim().length > 0);
    assert(typeof session.summary === 'string' && session.summary.trim().length > 0);
    title = session.title;
  }

  const spores: string[] = [];
  if (!skipped && (task === 'extract-curate' || task === 'vault-seed')) {
    for (let page = 0; ; page++) {
      assert(page < MAX_SPORE_PAGES, 'Spore evidence exceeds the smoke read bound');
      const result = await read('myco_spores', { op: 'list', status: 'all', limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      const found = rows(result.spores);
      for (const spore of found.filter((row) => row.author === runId)) {
        assert(typeof spore.id === 'string');
        assert(typeof spore.content === 'string' && spore.content.trim().length > 0);
        spores.push(spore.id);
      }
      if (found.length < PAGE_SIZE) break;
    }
    if (task === 'vault-seed') assert(spores.length > 0, 'Seeding left no readable spores attributed to the run');
  }
  return { runId, task, outcome: skipped ? 'skip' : 'write', title, spores, model: run.model, tokensUsed: run.tokens_used };
}
