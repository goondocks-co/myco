import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, withDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { REQUEST_CONTEXT_ENV } from '@myco/grove/request-context.js';
import { run as runOkf } from '@myco/cli/okf.js';
import { run as runConfig } from '@myco/cli/config.js';
import { reconcileManagedProjectFiles } from '@myco/symbionts/reconcile.js';
import { vi } from '../helpers/vi-shim.js';

/**
 * Phase 1A end-to-end smoke: real `myco okf` command path over a real
 * filesystem + grove DB, proving CLI ↔ capability gate ↔ OkfBundle ↔ validator
 * ↔ AGENTS.md pointer. Runs with cortex.enabled=false to prove OKF has no
 * Cortex dependency. The daemon-HTTP leg is exercised separately as a live
 * dogfood smoke (the plan's live-smoke rule).
 */

const PROJECT_ID = 'proj_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const AGENT_ID = 'claude-code';

let rootDir: string;
let projectRoot: string;
let vaultDir: string;
let written: string[];
let originalLog: typeof console.log;

function lastJson(): Record<string, unknown> {
  return JSON.parse(written.join('\n').trim().split('\n').filter(Boolean).join('')) as Record<string, unknown>;
}

async function okf(args: string[]): Promise<Record<string, unknown>> {
  written = [];
  process.exitCode = 0;
  await runOkf(args, vaultDir);
  return lastJson();
}

beforeEach(() => {
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-smoke-')));
  const home = path.join(rootDir, 'home');
  projectRoot = path.join(rootDir, 'project');
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  vi.stubEnv('MYCO_HOME', home);

  // Cortex OFF from the start — the bundle must still generate.
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\ncortex:\n  enabled: false\n');

  const grove = createGrove('Work', home);
  saveProjectManifest(vaultDir, {
    project: { id: PROJECT_ID, name: 'okf-smoke' },
    grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
  });
  registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-smoke', projectRoot, bindingId: 'g' }, home);
  vi.stubEnv(REQUEST_CONTEXT_ENV.projectRoot, projectRoot);
  vi.stubEnv(REQUEST_CONTEXT_ENV.projectId, PROJECT_ID);
  vi.stubEnv(REQUEST_CONTEXT_ENV.groveId, grove.id);
  vi.stubEnv(REQUEST_CONTEXT_ENV.machineId, 'machine-a');

  const gdb = resolveGroveDbPath(grove.id, home);
  fs.mkdirSync(path.dirname(gdb), { recursive: true });
  const db = openDatabase(gdb);
  createSchema(db);
  withDatabase(db, () => {
    registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
    insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'We chose the async lock.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
  });
  db.close();

  written = [];
  originalLog = console.log;
  console.log = ((...parts: unknown[]) => {
    written.push(parts.map((p) => String(p)).join(' '));
  }) as typeof console.log;
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  vi.unstubAllEnvs();
  closeDatabase();
  process.exitCode = 0;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

const okfPath = (rel: string) => path.join(projectRoot, 'okf', rel);

describe('OKF Phase 1A smoke', () => {
  it('walks the full CLI → capability → validator → AGENTS.md flow with cortex disabled', async () => {
    // 1. Off by default: maintain is blocked before OKF is enabled.
    const blocked = await okf(['maintain']);
    expect((blocked.error as { code: string }).code).toBe('okf_disabled');
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(projectRoot, 'okf'))).toBe(false);

    // 2. Enable via the REAL config-set path (project tier, no --scope flag).
    await runConfig(['set', 'okf.enabled', 'true'], vaultDir);
    expect(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf8')).toContain('okf:');

    // 3. Maintain → a valid published bundle (findings possible → acknowledge).
    process.exitCode = 0;
    const maintained = await okf(['maintain', '--acknowledge-publish']);
    expect(process.exitCode).toBe(0);
    expect(maintained.ok).toBe(true);
    for (const rel of ['index.md', 'log.md', '.myco-okf-maintain.json', 'guides/maintaining-this-bundle.md', 'spores/decisions/decision-1.md']) {
      expect(fs.existsSync(okfPath(rel))).toBe(true);
    }

    // 4. Save an editorial concept, then re-maintain (round-trip must survive).
    const conceptFile = path.join(rootDir, 'smoke.md');
    fs.writeFileSync(conceptFile, '---\ntype: Note\ntitle: Smoke\ndescription: Smoke concept.\ntags:\n  - okf\ntimestamp: 2026-07-05\nmyco_id: concepts/smoke\n---\n\nSmoke body.\n');
    const saved = await okf(['concept', 'save', '--id', 'concepts/smoke', '--input', `@${conceptFile}`]);
    expect(saved.bundleGeneration).toBe(2);
    expect(fs.existsSync(okfPath('concepts/smoke.md'))).toBe(true);

    process.exitCode = 0;
    const remaintained = await okf(['maintain', '--acknowledge-publish']);
    expect(process.exitCode).toBe(0);
    expect((remaintained.validation as { ok: boolean }).ok).toBe(true);
    expect(fs.existsSync(okfPath('concepts/smoke.md'))).toBe(true);

    // 5. Validate the published bundle.
    process.exitCode = 0;
    const validated = await okf(['validate', 'okf']);
    expect((validated.validation as { ok: boolean }).ok).toBe(true);

    // 6. AGENTS.md pointer reconciles from the enabled capability state.
    reconcileManagedProjectFiles(projectRoot, vaultDir, null);
    const agents = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('okf/index.md');
  });

  it('fails maintain on a corrupt concept and leaves the previous bundle intact', async () => {
    await runConfig(['set', 'okf.enabled', 'true'], vaultDir);
    await okf(['maintain', '--acknowledge-publish']);
    const sporeBefore = fs.readFileSync(okfPath('spores/decisions/decision-1.md'), 'utf8');

    // Corrupt an agent-maintained concept on disk.
    fs.mkdirSync(okfPath('concepts'), { recursive: true });
    fs.writeFileSync(okfPath('concepts/broken.md'), '---\nnot: valid\nno_type: here\n---\n\nMissing type.\n');

    process.exitCode = 0;
    const failed = await okf(['maintain', '--acknowledge-publish']);
    expect(process.exitCode).not.toBe(0);
    expect((failed.error as { code: string }).code).toBe('okf_validation_failed');
    // The previously published spore concept is untouched.
    expect(fs.readFileSync(okfPath('spores/decisions/decision-1.md'), 'utf8')).toBe(sporeBefore);
  });
});
