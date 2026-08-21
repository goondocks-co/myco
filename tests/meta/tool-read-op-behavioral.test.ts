/**
 * Behavioral read-op gate (phase-6 follow-up; both reviewers converged on it,
 * and the FIRST build of this gate was itself proven vacuous three ways —
 * wrong database, unreachable seeds, unreachable write. The rebuilt gate is
 * self-proving: it REQUIRES the one known write-on-read to fire, so a broken
 * fixture fails loudly instead of passing green.)
 *
 * Every (tool, op) classified `read` in TOOL_OP_CLASSIFICATION dispatches
 * through the real tool runtime — bound to the AMBIENT test DB via
 * `resolveDatabase` — against rows seeded through the REAL write paths.
 * Snapshots are per-op, full-row JSON digests per table (COUNT alone cannot
 * see an UPDATE-shaped touch). Any table an op dirties must be REGISTERED
 * for that exact op; and the registered `myco_plans:get` lineage touch must
 * actually be OBSERVED, or the gate fails demanding fixture repair.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { TOOL_OP_CLASSIFICATION } from '@myco/tools/lease-admission.js';
import { createMycoTools } from '@myco/tools/index.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import { assertGroveProjectId, createGroveId, createProjectId } from '@myco/grove/ids.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import type { DaemonClient } from '@myco/daemon/client.js';

const PROJECT_ID = assertGroveProjectId(createProjectId());
const CREATOR_SESSION = 'behav-creator-session';
const READER_SESSION = 'behav-reader-session';
const NOW = Math.floor(Date.now() / 1000);

function stubClient(): DaemonClient {
  const ok = async () => ({ ok: true, data: {} });
  return { get: ok, post: ok, put: ok, delete: ok } as unknown as DaemonClient;
}

/** Seed through the REAL write paths so read ops can actually find the rows. */
function seedReal(): void {
  registerAgent({ id: 'behav-agent', name: 'Behav', source: 'built-in', created_at: NOW });
  // The lineage touch attributes to the system agent — present in every
  // running daemon; the touch's FK silently swallows without it.
  registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco', source: 'built-in', created_at: NOW });
  upsertSession({ id: CREATOR_SESSION, agent: 'claude-code', started_at: NOW, created_at: NOW, machine_id: 'm', project_id: PROJECT_ID });
  upsertSession({ id: READER_SESSION, agent: 'claude-code', started_at: NOW, created_at: NOW, machine_id: 'm', project_id: PROJECT_ID });
  upsertPlan({
    id: 'behav-plan-1', logical_key: 'behav:plan-1', title: 'Behav plan', content: 'content',
    created_at: NOW, machine_id: 'm', project_id: PROJECT_ID, session_id: CREATOR_SESSION,
  });
  // A SECOND plan for the fixture pre-flight: the lineage touch is once-per
  // (plan, session) — probing the measured plan would consume the one write
  // the self-proof requires the measured loop to observe.
  upsertPlan({
    id: 'behav-plan-0', logical_key: 'behav:plan-0', title: 'Preflight plan', content: 'content',
    created_at: NOW, machine_id: 'm', project_id: PROJECT_ID, session_id: CREATOR_SESSION,
  });
  insertSpore({
    id: 'behav-spore-1', agent_id: 'behav-agent', session_id: CREATOR_SESSION,
    observation_type: 'decision', content: 'seeded', created_at: NOW, machine_id: 'm', project_id: PROJECT_ID,
  });
  insertSkillRecord({
    id: 'behav-skill-1', project_id: PROJECT_ID, agent_id: 'behav-agent', machine_id: 'm',
    name: 'behav-skill', display_name: 'Behav', description: 'd', path: '/p',
    created_at: NOW, updated_at: NOW,
  });
}

/** Full-row digest per table — sees UPDATEs, not just inserts/deletes. */
function digests(): Map<string, string> {
  const db = getDatabase();
  const out = new Map<string, string>();
  for (const table of GROVE_PROJECT_SCOPED_TABLES) {
    // Some scoped tables have no rowid (WITHOUT ROWID / composite PKs) —
    // fall back to unordered rows sorted in JS for a stable digest.
    let rows: unknown[];
    try {
      rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    } catch {
      rows = db.prepare(`SELECT * FROM ${table}`).all()
        .map((r) => JSON.stringify(r)).sort();
    }
    out.set(table, JSON.stringify(rows));
  }
  return out;
}

/** Designed write-on-read exceptions, per exact (tool, op). */
const READ_OP_WRITE_EXEMPTIONS: Record<string, readonly string[]> = {
  'myco_plans:get': ['graph_edges'], // the lineage touch, gated at its own site
};

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  myco_plans: { id: 'behav-plan-1' },
  myco_sessions: { id: CREATOR_SESSION },
  myco_spores: { id: 'behav-spore-1' },
  myco_skills: { id: 'behav-skill-1', name: 'behav-skill' },
};

describe('behavioral read-op gate', () => {
  let home: string;
  beforeAll(() => {
    setupTestDb();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-readop-'));
    process.env.MYCO_HOME = home;
    seedReal();
  });
  afterAll(() => {
    delete process.env.MYCO_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    teardownTestDb();
  });

  test('every read op changes NOTHING except its registered exemptions — and the known touch is OBSERVED firing', async () => {
    const vaultDir = path.join(home, 'proj', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const context = resolveLegacyRequestContext(vaultDir, {
      projectId: PROJECT_ID,
      groveId: createGroveId(), // grove-bound caller tenancy — without it the scope resolver falls to GLOBAL and misses every row
      machineId: 'test-machine',
      sessionId: READER_SESSION, // ≠ the plan's creator, so the lineage touch is reachable
      tenancySource: 'caller',
    });
    const tools = createMycoTools(vaultDir, stubClient(), {
      requestContext: context,
      // Bind the tool runtime to the AMBIENT test DB — without this, writes
      // land in an on-disk vault DB the assertions never look at (the exact
      // vacuity the first build of this gate shipped with).
      resolveDatabase: () => getDatabase(),
      mycoHome: home,
    });

    // Fixture pre-flight: the seeded plan MUST be retrievable through the
    // runtime, or every downstream claim is vacuous.
    const probe = await tools.callTool('myco_plans', { op: 'get', id: 'behav-plan-0' }) as Record<string, unknown>;
    if (probe.ok === false) throw new Error(`fixture broken: plans get -> ${JSON.stringify(probe)}`);

    const violations: string[] = [];
    const observedExemptions = new Set<string>();
    let attempted = 0;
    for (const [tool, entry] of Object.entries(TOOL_OP_CLASSIFICATION)) {
      if (!entry) continue;
      for (const op of entry.read) {
        attempted += 1;
        const key = `${tool}:${op}`;
        const before = digests();
        try {
          await tools.callTool(tool, { op, query: 'seeded', tier: 5000, ...(MINIMAL_ARGS[tool] ?? {}) });
        } catch { /* an op erroring on minimal args is fine — writes are not */ }
        const after = digests();
        const allowed = new Set(READ_OP_WRITE_EXEMPTIONS[key] ?? []);
        for (const [table, digest] of after) {
          if (digest === before.get(table)) continue;
          if (allowed.has(table)) { observedExemptions.add(`${key}->${table}`); continue; }
          violations.push(`${key} dirtied ${table}`);
        }
      }
    }

    expect(attempted).toBeGreaterThan(10); // the classification really was walked
    expect(violations).toEqual([]);
    // Self-proof: the one registered write-on-read MUST have been observed.
    // If it wasn't, the fixture regressed (wrong DB, unreachable row, absent
    // session) and this gate is not testing what it claims — fail loudly.
    expect([...observedExemptions]).toContain('myco_plans:get->graph_edges');
  });
});
