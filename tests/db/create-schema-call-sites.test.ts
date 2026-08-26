import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Meta-gate: the production `createSchema` call-site registry.
 *
 * Every call site is a migration surface. Each one must (a) be covered by
 * the pre-migration checkpoint — automatic, via the hook seam inside
 * `createSchema` itself — and (b) have a deliberate response to
 * `SchemaVersionTooNewError` (per-site: the boot site steps aside with a
 * marker, the lazy Grove cache refuses that Grove without killing the
 * daemon, the agent's local vault open returns a typed failure that fails the
 * run, provisioning/activation propagate).
 *
 * If this test failed on your change: you added or removed a
 * `createSchema` caller. Update EXPECTED_CALL_SITES *and* give the new
 * site a SchemaVersionTooNewError response with a test proving it.
 */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'daemon/main.ts': 1,
  'daemon/grove-runtime-cache.ts': 1,
  'grove/database.ts': 1,
  'grove/activation.ts': 2,
  'agent/runtime/run-store-local.ts': 1,
  'tools/index.ts': 1,
};

/** Files where `createSchema(` appears without being a vault-chain call. */
const EXCLUDED_FILES = new Set([
  'db/schema.ts', // the definition
  'daemon/embedding/sqlite-vec-store.ts', // unrelated private method for vectors.db
]);

const SRC_ROOT = path.resolve(import.meta.dir, '../../packages/myco/src');

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith('.ts')) yield full;
  }
}

function countCallSites(filePath: string): number {
  let count = 0;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (/\bfunction createSchema\(|\bprivate createSchema\(/.test(trimmed)) continue;
    if (/\bcreateSchema\(/.test(trimmed)) count += 1;
  }
  return count;
}

describe('production createSchema call-site registry', () => {
  it('matches the audited migration-surface set exactly', () => {
    const found: Record<string, number> = {};
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      if (EXCLUDED_FILES.has(rel)) continue;
      const count = countCallSites(file);
      if (count > 0) found[rel] = count;
    }
    expect(found).toEqual(EXPECTED_CALL_SITES);
  });

  it('the checkpoint hook is installed at every entry point that can migrate', () => {
    // Call-site coverage is structural (the hook lives inside createSchema),
    // but INSTALLATION is per-process: a process that never registers the
    // hook migrates without a checkpoint. Every entry point whose commands
    // can reach a production createSchema caller must install it.
    const REQUIRED_INSTALLERS = ['daemon/main.ts', 'cli.ts'];
    for (const rel of REQUIRED_INSTALLERS) {
      const content = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
      const installs = content
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .filter((l) => /\binstallPreMigrationCheckpoint\(/.test(l));
      expect(installs.length, `${rel} must install the pre-migration checkpoint`).toBeGreaterThan(0);
    }
  });
});
