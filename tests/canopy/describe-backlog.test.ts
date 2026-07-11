import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { withDatabase } from '@myco/db/client';
import { CANOPY_ENTRIES_TABLE } from '@myco/db/schema-ddl';
import { ALL_PROJECTS_SCOPE, projectScope } from '@myco/grove/ids';
import {
  archiveProjectInGrove,
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry';
import { createCanopyDescribeBacklogReader, effectiveCanopyDescribeMaxAttempts } from '@myco/canopy/describe-backlog';
import { getCanopyDescribeBacklog, DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS } from '@myco/db/queries/canopy';
import { resolveGroveConfigPath } from '@myco/grove/paths';
import { invalidateMergedConfigCache } from '@myco/config/loader';

let home: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-describe-backlog-'));
  clearGroveRegistryCaches();
  db = new Database(':memory:');
  db.prepare(CANOPY_ENTRIES_TABLE).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function insertUndescribedEntry(projectId: string, filePath: string): void {
  db.prepare(
    `INSERT INTO canopy_entries (
      project_id, path, content_hash, size_bytes, token_estimate,
      line_count, mechanical_updated_at, llm_description, llm_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, filePath, `hash-${filePath}`, 10, 5, 1, 200, null, null);
}

/**
 * Materialize a project's `.myco` config on disk. A registered project always
 * has a myco.yaml (loadMergedConfig requires it), so the capability resolver
 * can read it; the capture-only off-gate lives in local.yaml, mirroring how
 * the daemon resolves a Canopy-disabled project.
 */
function writeProjectConfig(root: string, opts: { canopyEnabled: boolean }): string {
  const vaultDir = path.join(root, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
  if (!opts.canopyEnabled) {
    fs.writeFileSync(
      path.join(vaultDir, 'local.yaml'),
      'cortex:\n  enabled: false\n  canopy:\n    enabled: false\n',
    );
  }
  return root;
}

describe('canopy describe backlog reader', () => {
  it('grove-wide reads count only active registered projects', () => {
    const grove = createGrove('Test Grove', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_active',
      projectName: 'active',
      projectRoot: writeProjectConfig(path.join(home, 'active-project'), { canopyEnabled: true }),
      bindingId: 'gbind_active',
    }, home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_archived',
      projectName: 'archived',
      projectRoot: path.join(home, 'archived-project'),
      bindingId: 'gbind_archived',
    }, home);
    archiveProjectInGrove(grove.id, 'proj_archived', home);

    insertUndescribedEntry('proj_active', 'a.ts');
    insertUndescribedEntry('proj_active', 'b.ts');
    insertUndescribedEntry('proj_archived', 'c.ts');
    insertUndescribedEntry('proj_deleted_orphan', 'd.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(ALL_PROJECTS_SCOPE, { groveId: grove.id }),
    );

    expect(backlog).toEqual({ pending: 2, undescribed: 2, stale: 0, stuck: 0 });
  });

  it('grove-wide reads exclude registered projects with Canopy disabled', () => {
    const grove = createGrove('Test Grove', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_enabled',
      projectName: 'enabled',
      projectRoot: writeProjectConfig(path.join(home, 'enabled-project'), { canopyEnabled: true }),
      bindingId: 'gbind_enabled',
    }, home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_disabled',
      projectName: 'disabled',
      projectRoot: writeProjectConfig(path.join(home, 'disabled-project'), { canopyEnabled: false }),
      bindingId: 'gbind_disabled',
    }, home);

    insertUndescribedEntry('proj_enabled', 'a.ts');
    insertUndescribedEntry('proj_disabled', 'b.ts');
    insertUndescribedEntry('proj_disabled', 'c.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(ALL_PROJECTS_SCOPE, { groveId: grove.id }),
    );

    // proj_disabled's two rows are dropped; only proj_enabled's one counts.
    expect(backlog).toEqual({ pending: 1, undescribed: 1, stale: 0, stuck: 0 });
  });

  it('a served-treeless registered project (no local myco.yaml at all) still counts — degrades to the schema default (canopy on) instead of always excluding it (Task C-6 item 1)', () => {
    // A Team Host owns this project's Grove row but the checkout — and so
    // `.myco/myco.yaml` — lives on the member's machine, never this one.
    // Before the fix, `loadMergedConfig` here had no `projectTierOptional`,
    // so it always threw "myco.yaml not found" -> the catch degraded to
    // `capabilityEnabled(null, 'canopy') === false` -> every served-treeless
    // project was silently excluded from grove-wide counts regardless of
    // its actual machine+grove-tier canopy setting. `cortex.canopy.enabled`
    // defaults to `true` in the schema, so with the fix this project now
    // degrades to machine+grove tiers (both empty here) and correctly
    // counts as Canopy-enabled.
    const grove = createGrove('Test Grove', home);
    const treelessRoot = path.join(home, 'served-treeless-project');
    // Deliberately never materialized on disk — no .myco/myco.yaml at all.
    expect(fs.existsSync(treelessRoot)).toBe(false);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_served_treeless',
      projectName: 'served treeless',
      projectRoot: treelessRoot,
      bindingId: 'gbind_served_treeless',
    }, home);

    insertUndescribedEntry('proj_served_treeless', 'a.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(ALL_PROJECTS_SCOPE, { groveId: grove.id }),
    );

    expect(backlog).toEqual({ pending: 1, undescribed: 1, stale: 0, stuck: 0 });
  });

  it('project-scoped reads report an empty backlog when Canopy is disabled', () => {
    const grove = createGrove('Test Grove', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_disabled',
      projectName: 'disabled',
      projectRoot: writeProjectConfig(path.join(home, 'disabled-project'), { canopyEnabled: false }),
      bindingId: 'gbind_disabled',
    }, home);

    insertUndescribedEntry('proj_disabled', 'a.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(projectScope('proj_disabled'), { groveId: grove.id }),
    );

    expect(backlog).toEqual({ pending: 0, undescribed: 0, stale: 0, stuck: 0 });
  });

  it('falls back to the unrestricted count when the grove record is unknown', () => {
    insertUndescribedEntry('proj_anything', 'a.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(ALL_PROJECTS_SCOPE, { groveId: 'grove_missing' }),
    );

    expect(backlog.undescribed).toBe(1);
  });

  it('project-scoped reads stay unrestricted by the registry', () => {
    insertUndescribedEntry('proj_unregistered', 'a.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(projectScope('proj_unregistered'), { groveId: null }),
    );

    expect(backlog.undescribed).toBe(1);
  });
});

describe('getCanopyDescribeBacklog — describe_attempts budget', () => {
  function insertStaleEntry(projectId: string, filePath: string): void {
    db.prepare(
      `INSERT INTO canopy_entries (
        project_id, path, content_hash, size_bytes, token_estimate,
        line_count, mechanical_updated_at, llm_description, llm_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, filePath, `hash-${filePath}`, 10, 5, 1, 200, 'old description', 100);
  }

  it('excludes capped rows from every bucket — no phantom backlog from a poisoned tail', () => {
    insertUndescribedEntry('proj_a', 'fresh.ts');
    insertUndescribedEntry('proj_a', 'poisoned.ts');
    insertStaleEntry('proj_a', 'stale-poisoned.ts');
    db.prepare(
      `UPDATE canopy_entries SET describe_attempts = 2 WHERE path IN ('poisoned.ts', 'stale-poisoned.ts')`,
    ).run();

    const backlog = getCanopyDescribeBacklog(db, projectScope('proj_a'));
    expect(backlog).toEqual({ pending: 1, undescribed: 1, stale: 0, stuck: 2 });
  });

  it('reports zero against a fully-poisoned tail, matching the scheduler count', () => {
    insertUndescribedEntry('proj_a', 'a.ts');
    insertStaleEntry('proj_a', 'b.ts');
    db.prepare('UPDATE canopy_entries SET describe_attempts = 2').run();

    expect(getCanopyDescribeBacklog(db, projectScope('proj_a')))
      .toEqual({ pending: 0, undescribed: 0, stale: 0, stuck: 2 });
  });

  it('honors a larger per-project maxAttempts', () => {
    insertUndescribedEntry('proj_a', 'a.ts');
    insertStaleEntry('proj_a', 'b.ts');
    db.prepare('UPDATE canopy_entries SET describe_attempts = 2').run();

    expect(getCanopyDescribeBacklog(db, projectScope('proj_a'), { maxAttempts: 4 }))
      .toEqual({ pending: 2, undescribed: 1, stale: 1, stuck: 0 });
  });
});

describe('effectiveCanopyDescribeMaxAttempts — served-treeless degrade (Task C-6 item 1)', () => {
  it('picks up a GROVE-tier max_attempts override for a served-treeless registered project', () => {
    // `agent.tasks.canopy-describe.params.max_attempts` is Grove-tier
    // (config/scope.ts: `agent` home is 'grove'), so it resolves from the
    // machine's own Grove config regardless of the project's working tree
    // — UNLESS `loadMergedConfig` throws before ever reaching the grove
    // tier, which is exactly what happened before the fix: no
    // `projectTierOptional` meant a served-treeless project's merge always
    // threw "myco.yaml not found", the catch fell back to
    // `DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS` unconditionally, and a real
    // Grove-tier override for that project was silently ignored.
    const grove = createGrove('Test Grove', home);
    const treelessRoot = path.join(home, 'served-treeless-max-attempts');
    expect(fs.existsSync(treelessRoot)).toBe(false);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_served_treeless_maxattempts',
      projectName: 'served treeless',
      projectRoot: treelessRoot,
      bindingId: 'gbind_served_treeless_maxattempts',
    }, home);

    const overrideValue = DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS + 7;
    const groveConfigPath = resolveGroveConfigPath(grove.id, home);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    fs.writeFileSync(
      groveConfigPath,
      `agent:\n  tasks:\n    canopy-describe:\n      params:\n        max_attempts: ${overrideValue}\n`,
    );
    invalidateMergedConfigCache();

    const resolved = effectiveCanopyDescribeMaxAttempts(
      projectScope('proj_served_treeless_maxattempts'),
      grove.id,
      home,
    );

    expect(resolved).toBe(overrideValue);
    expect(resolved).not.toBe(DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS);
  });
});
