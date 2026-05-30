import { describe, it, expect } from 'bun:test';
import { resolveWorkerUrl, withCustomDomainRoute } from '../../packages/myco-team/src/cli.js';

describe('custom domain', () => {
  it('resolveWorkerUrl returns the custom domain URL when a zone is given, else null', () => {
    expect(resolveWorkerUrl('myco-projects', 'goondocks.org')).toBe('https://myco-projects.goondocks.org');
    expect(resolveWorkerUrl('myco-projects', undefined)).toBeNull();
    expect(resolveWorkerUrl('myco-projects', null)).toBeNull();
  });
  it('withCustomDomainRoute appends a custom_domain route block (idempotent)', () => {
    const base = 'name = "myco-team-myco-projects-abc123"\n';
    const once = withCustomDomainRoute(base, 'myco-projects', 'goondocks.org');
    expect(once).toContain('[[routes]]');
    expect(once).toContain('pattern = "myco-projects.goondocks.org"');
    expect(once).toContain('custom_domain = true');
    // custom-domain-only: the route disables the *.workers.dev URL, and we do
    // NOT re-enable it — the daemon seeds config/MCP on first connect instead.
    expect(once).not.toContain('workers_dev = true');
    // idempotent: applying again doesn't add a second block
    const twice = withCustomDomainRoute(once, 'myco-projects', 'goondocks.org');
    expect(twice.match(/\[\[routes\]\]/g)?.length).toBe(1);
  });
});
