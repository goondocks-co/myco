import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forEachGrove } from '@myco/daemon/scope-iteration.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import type { Logger } from '@myco/daemon/logger.js';

const noopLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;

function seedTwoGroves(mycoHome: string) {
  for (const [id, name, slug, served] of [
    ['grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Default', 'default', 'service'],
    ['grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Dogfood', 'dogfood', 'service-dev'],
  ] as const) {
    const groveDir = path.join(mycoHome, 'groves', id);
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(path.join(groveDir, 'grove.toml'),
      `[grove]\nid = "${id}"\nname = "${name}"\nslug = "${slug}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\nserved_by = "${served}"\n`);
  }
}

describe('forEachGrove ownership boundary', () => {
  let mycoHome: string;
  beforeEach(() => {
    mycoHome = mkdtempSync(path.join(tmpdir(), 'myco-feg-'));
    mkdirSync(path.join(mycoHome, 'groves'), { recursive: true });
    mkdirSync(path.join(mycoHome, 'service'), { recursive: true });
    mkdirSync(path.join(mycoHome, 'service-dev'), { recursive: true });
    seedTwoGroves(mycoHome);
  });

  it('service-dev daemon visits only service-dev-owned groves', async () => {
    const visited: string[] = [];
    const cache = new GroveRuntimeCache();
    await forEachGrove(
      cache,
      noopLogger,
      ({ grove }) => { visited.push(grove.slug); },
      { mycoHome, daemonStateDir: path.join(mycoHome, 'service-dev') },
    );
    expect(visited).toEqual(['dogfood']);
  });

  it('service daemon visits only service-owned groves', async () => {
    const visited: string[] = [];
    const cache = new GroveRuntimeCache();
    await forEachGrove(
      cache,
      noopLogger,
      ({ grove }) => { visited.push(grove.slug); },
      { mycoHome, daemonStateDir: path.join(mycoHome, 'service') },
    );
    expect(visited).toEqual(['default']);
  });
});
