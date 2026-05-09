import { describe, expect, it } from 'bun:test';
import {
  assertGroveProjectId,
  createGroveBindingId,
  createGroveEraId,
  createGroveId,
  createMigrationId,
  createMigrationMappingId,
  createProjectId,
  isGroveEraId,
} from '@myco/grove/ids.js';

describe('Grove-era ID helpers', () => {
  it('generates opaque typed ids for Grove registration identities', () => {
    expect(createGroveId()).toMatch(/^grove_[0-9a-f]{32}$/);
    expect(createProjectId()).toMatch(/^proj_[0-9a-f]{32}$/);
    expect(createGroveBindingId()).toMatch(/^gbind_[0-9a-f]{32}$/);
  });

  it('generates typed ids for migration journal rows', () => {
    const migrationId = createMigrationId();
    const mappingId = createMigrationMappingId();

    expect(migrationId).toMatch(/^mig_[0-9a-f]{32}$/);
    expect(mappingId).toMatch(/^mmap_[0-9a-f]{32}$/);
    expect(isGroveEraId(migrationId, 'migration')).toBe(true);
    expect(isGroveEraId(mappingId, 'migration_mapping')).toBe(true);
  });

  it('keeps ids independent from names, paths, and remotes', () => {
    const id = createGroveEraId('plan');

    expect(id).toMatch(/^plan_[0-9a-f]{32}$/);
    expect(id).not.toContain('/');
    expect(id).not.toContain(':');
    expect(id).not.toContain('myco');
  });

  it('rejects ids with the wrong type prefix', () => {
    const id = createGroveEraId('spore');

    expect(isGroveEraId(id)).toBe(true);
    expect(isGroveEraId(id, 'spore')).toBe(true);
    expect(isGroveEraId(id, 'plan')).toBe(false);
  });

  it('produces collision-resistant values across repeated calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createGroveEraId('session')));

    expect(ids.size).toBe(200);
  });
});

describe('assertGroveProjectId', () => {
  it('returns the value unchanged for a valid proj_<32hex> id', () => {
    const id = createProjectId();

    expect(assertGroveProjectId(id)).toBe(id);
  });

  it('rejects path-string project ids (the legacy bug)', () => {
    expect(() => assertGroveProjectId('/Users/chris/Repos/myco')).toThrow();
    expect(() => assertGroveProjectId('/tmp/example')).toThrow();
  });

  it('rejects null, undefined, empty string', () => {
    expect(() => assertGroveProjectId(null)).toThrow();
    expect(() => assertGroveProjectId(undefined)).toThrow();
    expect(() => assertGroveProjectId('')).toThrow();
  });

  it('rejects Grove ids with the wrong prefix', () => {
    expect(() => assertGroveProjectId(createGroveId())).toThrow();
    expect(() => assertGroveProjectId(createGroveEraId('session'))).toThrow();
    expect(() => assertGroveProjectId(createGroveBindingId())).toThrow();
  });

  it('rejects malformed proj_ values (wrong length, non-hex)', () => {
    expect(() => assertGroveProjectId('proj_short')).toThrow();
    expect(() => assertGroveProjectId('proj_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow();
    expect(() => assertGroveProjectId('proj_')).toThrow();
  });
});
