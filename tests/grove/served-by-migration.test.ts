import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listGroves, loadGroveRecord, createGrove } from '@myco/grove/registry.js';

describe('GroveRecord served_by', () => {
  let mycoHome: string;
  beforeEach(() => {
    mycoHome = mkdtempSync(path.join(tmpdir(), 'myco-served-by-'));
    mkdirSync(path.join(mycoHome, 'groves'), { recursive: true });
  });

  it('defaults to "service" when missing on read (migration)', () => {
    const groveDir = path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(path.join(groveDir, 'grove.toml'),
      `[grove]\nid = "grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "Default"\nslug = "default"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\n`);
    const record = loadGroveRecord('grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mycoHome);
    expect(record?.served_by).toBe('service');
  });

  it('round-trips an explicit served_by value', () => {
    const groveDir = path.join(mycoHome, 'groves', 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(path.join(groveDir, 'grove.toml'),
      `[grove]\nid = "grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\nname = "Dogfood"\nslug = "dogfood"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\nserved_by = "service-dev"\n`);
    expect(loadGroveRecord('grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', mycoHome)?.served_by).toBe('service-dev');
  });

  it('createGrove writes served_by based on caller', () => {
    const grove = createGrove('Test', mycoHome, { servedBy: 'service-dev' });
    expect(grove.served_by).toBe('service-dev');
    expect(loadGroveRecord(grove.id, mycoHome)?.served_by).toBe('service-dev');
  });
});

describe('listGroves filtering', () => {
  let mycoHome: string;
  beforeEach(() => {
    mycoHome = mkdtempSync(path.join(tmpdir(), 'myco-list-'));
    mkdirSync(path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
    writeFileSync(path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'grove.toml'),
      `[grove]\nid = "grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "Default"\nslug = "default"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\nserved_by = "service"\n`);
    mkdirSync(path.join(mycoHome, 'groves', 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), { recursive: true });
    writeFileSync(path.join(mycoHome, 'groves', 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'grove.toml'),
      `[grove]\nid = "grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\nname = "Dogfood"\nslug = "dogfood"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\nserved_by = "service-dev"\n`);
  });

  it('returns all groves when no filter passed', () => {
    expect(listGroves(mycoHome).map((g) => g.slug).sort()).toEqual(['default', 'dogfood']);
  });

  it('filters to service-owned groves', () => {
    expect(listGroves(mycoHome, { servedBy: 'service' }).map((g) => g.slug)).toEqual(['default']);
  });

  it('filters to service-dev-owned groves', () => {
    expect(listGroves(mycoHome, { servedBy: 'service-dev' }).map((g) => g.slug)).toEqual(['dogfood']);
  });
});
