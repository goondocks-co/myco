import { describe, it, expect } from 'bun:test';
import { isProjectRootIgnored, agentHomeIgnorePaths } from '../../packages/myco/src/vault/capture-ignore';

describe('isProjectRootIgnored', () => {
  const seed = ['/home/u/.codex', '/home/u/.claude'];
  it('ignores a root under a configured path prefix', () => {
    expect(isProjectRootIgnored('/home/u/repos/work/api', { paths: ['/home/u/repos/work'], patterns: [] }, [])).toBe(true);
  });
  it('ignores a root under an agent-home seed dir', () => {
    expect(isProjectRootIgnored('/home/u/.codex/memories', { paths: [], patterns: [] }, seed)).toBe(true);
  });
  it('ignores a root matching a glob pattern', () => {
    expect(isProjectRootIgnored('/home/u/sandbox/throwaway', { paths: [], patterns: ['**/sandbox/**'] }, [])).toBe(true);
  });
  it('does not ignore an unrelated root', () => {
    expect(isProjectRootIgnored('/home/u/repos/myco', { paths: ['/home/u/repos/work'], patterns: [] }, seed)).toBe(false);
  });
  it('the exact configured/seed dir itself is ignored', () => {
    expect(isProjectRootIgnored('/home/u/.codex', { paths: [], patterns: [] }, seed)).toBe(true);
  });
});

describe('agentHomeIgnorePaths', () => {
  it('returns expanded symbiont detectionDir paths', () => {
    const paths = agentHomeIgnorePaths();
    expect(paths.some((p) => p.endsWith('/.codex'))).toBe(true);
    expect(paths.every((p) => !p.startsWith('~'))).toBe(true); // expanded
  });
});
