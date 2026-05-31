import { describe, it, expect } from 'bun:test';
import { resolveUpgradedWorkerUrl, resolveWorkerUrl, withCustomDomainRoute } from '../../packages/myco-team/src/cli.js';

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
  it('resolveUpgradedWorkerUrl keeps the custom domain even when the deploy output parses a workers.dev URL', () => {
    // A custom-domain worker still exposes a working *.workers.dev URL, so
    // parsedUrl is non-null on every upgrade — adopting it would repoint the
    // team off its custom domain. The custom domain must win.
    expect(resolveUpgradedWorkerUrl({
      domain: 'example.co',
      slug: 'myco-projects',
      parsedUrl: 'https://myco-team-myco-projects-abc123.workers.dev',
      previousUrl: 'https://myco-projects.example.co',
    })).toBe('https://myco-projects.example.co');
  });
  it('resolveUpgradedWorkerUrl uses the parsed workers.dev URL when no custom domain', () => {
    expect(resolveUpgradedWorkerUrl({
      domain: null,
      slug: 'myco-projects',
      parsedUrl: 'https://myco-team-myco-projects-abc123.workers.dev',
      previousUrl: 'https://stale.workers.dev',
    })).toBe('https://myco-team-myco-projects-abc123.workers.dev');
  });
  it('resolveUpgradedWorkerUrl falls back to the previous URL when no domain and nothing parsed', () => {
    expect(resolveUpgradedWorkerUrl({
      domain: null,
      slug: 'myco-projects',
      parsedUrl: null,
      previousUrl: 'https://stale.workers.dev',
    })).toBe('https://stale.workers.dev');
  });
});
