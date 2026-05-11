import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { resolveServiceDirName } from '@myco/grove/paths.js';

describe('resolveServiceDirName', () => {
  it('returns "service" for the default service dir', () => {
    const mycoHome = '/Users/test/.myco';
    const stateDir = path.join(mycoHome, 'service');
    expect(resolveServiceDirName(stateDir, mycoHome)).toBe('service');
  });

  it('returns "service-dev" for the dogfood service dir', () => {
    const mycoHome = '/Users/test/.myco';
    const stateDir = path.join(mycoHome, 'service-dev');
    expect(resolveServiceDirName(stateDir, mycoHome)).toBe('service-dev');
  });

  it('throws on an unrecognized service dir', () => {
    expect(() => resolveServiceDirName('/tmp/random', '/Users/test/.myco')).toThrow(/Unrecognized daemon service dir/);
  });
});
