import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeLegacyMigration } from '@myco/member/legacy-confirmation.js';
import { readCutoverState } from '@myco/member/legacy-migration.js';
import { writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH } from '@goondocks/myco-shared/member-protocol';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let root: string;
let restore: () => void;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-evidence-'));
  restore = bindSandboxChildHome(root, { MYCO_HOME: path.join(root, 'myco') });
});
afterEach(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

for (const allConfirmed of [true, false]) it(`requires every bounded proof batch before backfilling a large source: ${allConfirmed}`, async () => {
  const home = path.join(root, 'myco');
  const folder = path.join(root, 'repo');
  const vault = path.join(home, 'groves', 'retained', 'myco.db');
  fs.mkdirSync(folder); fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  const count = Math.floor(LEGACY_HISTORY_MAX_EVENTS / 2) + 1;
  try {
    for (let index = 0; index < count; index++) db.run("INSERT INTO sessions (id, project_id, project_root, agent, started_at, ended_at, status, created_at) VALUES (?, 'proj_old', ?, 'claude-code', 1700000000, 1700000060, 'completed', 1700000000)", [`source-${index}`, folder]);
  } finally { db.close(); }
  const membership = { serverUrl: 'https://evidence.invalid', token: 'F'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 };
  writeDeploymentMembership(membership, { mycoHome: home });
  writeRegistryEntry({ ...membership, version: 2, root: folder, projectId: 'proj_old' }, { mycoHome: home });
  const bytes = fs.readFileSync(vault);
  let batches = 0;
  const result = await observeLegacyMigration(home, { fetch: async (input, init) => {
    expect(new URL(new Request(input, init).url).pathname).toBe(LEGACY_HISTORY_PATH);
    const { eventGroups } = JSON.parse(String(init?.body)) as { eventGroups: string[][] };
    expect(eventGroups.flat().length).toBeLessThanOrEqual(LEGACY_HISTORY_MAX_EVENTS);
    expect(readCutoverState(home).migrations).toBeUndefined();
    batches++;
    const confirmed = allConfirmed || batches === 1;
    return Response.json({ persisted: true, confirmed, ...(confirmed ? { eventIds: eventGroups.map(group => group[0]) } : {}) });
  } });
  expect(batches).toBe(2);
  expect(result.state).toBe(allConfirmed ? 'moved' : 'unmoved');
  if (allConfirmed) expect(readCutoverState(home).migrations?.[vault]?.projects.proj_old?.evidence?.eventIds).toHaveLength(count);
  else expect(readCutoverState(home).migrations).toBeUndefined();
  expect(fs.readFileSync(vault)).toEqual(bytes);
});
