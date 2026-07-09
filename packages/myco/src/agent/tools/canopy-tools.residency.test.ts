import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { createCanopyTools } from './canopy-tools.js';
import type { VaultToolDeps } from './types.js';

/**
 * Task B1 — canopy_describe_next is the second mis-scoping READ. On a host-served
 * run `projectRoot` is the member's tree the host lacks, so reading each row's
 * `first_lines` from it would return empty/wrong content. The gate degrades to
 * `first_lines: null` without touching disk, while the DB-resident row fields
 * still flow. A local run reads the real file head unchanged.
 */

const FILE_REL = 'src/example.ts';
const FILE_HEAD = 'export function example() {\n  return 42;\n}\n';

describe('Task B1 — canopy_describe_next tree read gate (overlay-origin)', () => {
  let db: Database;
  let projectRoot: string;
  const projectId = assertGroveProjectId(createProjectId());

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    projectRoot = mkdtempSync(path.join(tmpdir(), 'myco-canopy-residency-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, FILE_REL), FILE_HEAD, 'utf-8');
    withDatabase(db, () => {
      // Minimal pending canopy_entries row: llm_updated_at NULL ⇒ needs a
      // description, describe_attempts 0 ⇒ under the retry budget.
      db.prepare(
        `INSERT INTO canopy_entries
           (project_id, machine_id, path, content_hash, size_bytes, token_estimate,
            line_count, language, exports_json, imports_json, top_comment,
            mechanical_updated_at, describe_attempts)
         VALUES (?, 'local', ?, 'hash', 42, 10, 3, 'typescript', '["example"]', '[]', NULL, ?, 0)`,
      ).run(projectId, FILE_REL, epochSeconds());
    });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function deps(hostServed: boolean): VaultToolDeps {
    const requestContext: MycoRequestContext = {
      projectRoot,
      callerRoot: null,
      projectId,
      groveId: null,
      machineId: 'test-machine',
      sessionId: null,
      projectVaultDir: path.join(projectRoot, '.myco'),
      databasePath: ':memory:',
      source: 'headers',
      tenancySource: 'caller',
      hostServed,
    };
    return {
      agentId: 'test-agent',
      runId: 'canopy-residency-run',
      projectRoot,
      vaultDir: path.join(projectRoot, '.myco'),
      requestContext,
      recordTurn: () => null,
    };
  }

  async function describeNext(hostServed: boolean): Promise<Array<Record<string, unknown>>> {
    const tools = createCanopyTools(deps(hostServed)) as Array<{ name: string; handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> }>;
    const describe = tools.find((t) => t.name === 'canopy_describe_next')!;
    const res = await describe.handler({}, {});
    const parsed = JSON.parse(res.content[0].text) as { entries: Array<Record<string, unknown>> };
    return parsed.entries;
  }

  test('local run: first_lines is read from the real file head', async () => {
    await withDatabase(db, async () => {
      const entries = await describeNext(false);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe(FILE_REL);
      expect(entries[0].first_lines).toContain('export function example');
    });
  });

  test('host-served run: first_lines degrades to null (no host-tree read); DB fields still flow', async () => {
    await withDatabase(db, async () => {
      const entries = await describeNext(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe(FILE_REL);
      expect(entries[0].first_lines).toBeNull();
      // DB-resident fields are unaffected by the tree-read gate.
      expect(entries[0].exports).toEqual(['example']);
      expect(entries[0].language).toBe('typescript');
    });
  });
});
