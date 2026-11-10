/**
 * Settings have one writer: every change admits the leaf, authorizes the actor,
 * checks the leaf's rule, persists it with its actor and re-arms its schedule,
 * in that order, in one module. These gates hold the persistence family private
 * to that writer and the settings tables named only where they are owned.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeImportNames, moduleKey } from '../../helpers/import-closure.js';

const SRC = fileURLToPath(new URL('../../../packages/myco-server/src/', import.meta.url)).replace(/\/$/, '');
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });
const files = (dir: string): string[] => allFiles(dir).filter((f) => f.endsWith('.ts'));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('settings one writer', () => {
  it('keeps db/settings persistence private to the admitted writer', () => {
    const family = `${moduleKey(join(SRC, 'db', 'settings'))}/`;
    const writer = moduleKey(join(SRC, 'core', 'settings.ts'));
    const owners = new Map([
      [family + 'leaves.ts', new Set([writer, moduleKey(join(SRC, 'db', 'runs', 'claim.ts'))])],
      [family + 'release-connection.ts', new Set([moduleKey(join(SRC, 'core', 'release-provenance.ts'))])],
      [family + 'secret-writes.ts', new Set([
        moduleKey(join(SRC, 'core', 'secrets.ts')),
        moduleKey(join(SRC, 'db', 'storage', 'repository-connection.ts')),
        family + 'release-connection.ts',
      ])],
      [family + 'secret-rows.ts', new Set([moduleKey(join(SRC, 'core', 'secrets.ts'))])],
      [family + 'machines.ts', new Set([moduleKey(join(SRC, 'core', 'machine-settings.ts'))])],
    ]);
    // The admission SQL other batches read through is shared on purpose: it holds no write.
    const shared = family + 'admission.ts';
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const from = moduleKey(file);
      for (const target of runtimeImportNames(readFileSync(file, 'utf8'), file).keys()) {
        if (target.startsWith(family) && target !== shared && !owners.get(target)?.has(from)) offenders.push(`${from} imports ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writes settings and capability admission from exactly one module, keyed on the tables themselves', () => {
    // Keying this on MODULE PATHS alone would not hold: the read-layer allowlist
    // already permits every file under `ingest/` and `db/` to issue SQL, so a
    // settings write from the ingest path would pass that gate untouched. The
    // property is about the TABLES, so the gate is too — their names may appear
    // only where they are owned.
    //
    // What it protects is the write ORDER. Validate, authorize, persist, record the
    // actor, re-arm. A second writer is how one of those five goes missing on one
    // path, and the one that goes missing silently is the actor.
    const OWNED: Record<string, string> = {
      setting_revisions: join('core', 'settings.ts'),
      deployment_settings: join('core', 'settings.ts'),
      deployment_setting_resets: join('core', 'settings.ts'),
      project_capabilities: join('core', 'settings.ts'),
      project_settings: join('core', 'settings.ts'),
      deployment_secrets: join('core', 'secrets.ts'),
      machine_settings: join('core', 'machine-settings.ts'),
      embedding_switches: join('core', 'embedding', 'switch-store.ts'),
      embedding_source_failures: join('core', 'embedding', 'reconcile.ts'),
    };
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel.startsWith(`db${sep}`) && !rel.startsWith(`db${sep}settings${sep}`)) {
        if (!rel.startsWith(`db${sep}schema`)) {
          const source = stripComments(readFileSync(file, 'utf8'));
          for (const table of ['setting_revisions', 'deployment_settings', 'deployment_setting_resets', 'project_settings', 'project_capabilities']) {
            if (new RegExp(`\\b${table}\\b`).test(source)) offenders.push(`${rel} names ${table}`);
          }
        }
        continue;
      }
      if (rel.startsWith(`db${sep}settings${sep}`)) continue;
      // Comments are stripped first: the property is about a second WRITER, and a
      // docstring that names a table in prose is not one. Scanning raw source made
      // the gate fire on its own explanation of what it protects.
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const [table, owner] of Object.entries(OWNED)) {
        if (rel === owner) continue;
        // The backup engine's exclusion ledger names these tables to keep them out
        // of every artifact; only a line that also carries a SQL verb is a writer.
        if (rel === join('core', 'backup.ts')) {
          const sqlLines = source.split('\n').filter((l) => new RegExp(`\\b${table}\\b`).test(l) && /\b(INTO|UPDATE|DELETE|SELECT)\b/i.test(l));
          if (sqlLines.length === 0) continue;
        }
        if (new RegExp(`\\b${table}\\b`).test(source)) offenders.push(`${rel} names ${table}`);
      }
    }
    expect(offenders).toEqual([]);

    // And the owner really does carry every step, so the gate is guarding something.
    const settings = readFileSync(join(SRC, 'core', 'settings.ts'), 'utf8');
    for (const step of ['authorize(', 'updated_by', 'rearm(']) {
      expect({ step, present: settings.includes(step) }).toEqual({ step, present: true });
    }
  });
});
