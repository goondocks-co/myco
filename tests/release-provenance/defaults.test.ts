import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { MycoConfigSchema } from '@myco/config/schema.js';
import {
  inferReleaseProvenanceDefaults,
  withInferredReleaseProvenanceDefaults,
} from '@myco/release-provenance/defaults.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(name = 'myco-defaults'): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-parent-`));
  const repo = path.join(parent, name);
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n', 'utf-8');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-qm', 'first']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['remote', 'add', 'origin', 'git@github.com:goondocks-co/myco.git']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return repo;
}

function removeRemoteTrackingRefs(repo: string): void {
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/HEAD']);
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
}

describe('release provenance defaults', () => {
  it('infers GitHub repo, integration branch, and project-scoped tag family from Git', () => {
    const repo = makeRepo('myco');
    try {
      git(repo, ['tag', 'myco/v1.2.3']);

      const defaults = inferReleaseProvenanceDefaults(repo);

      expect(defaults.production_refs).toEqual(['refs/tags/myco/v*']);
      expect(defaults.integration_refs).toEqual(['origin/main']);
      expect(defaults.github.repo).toBe('goondocks-co/myco');
      expect(defaults.github.token_env).toBe('GITHUB_TOKEN');
      expect(defaults.github.max_lookups_per_run).toBe(20);
    } finally {
      fs.rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  });

  it('uses semver tag releases as the Git fallback without existing tags', () => {
    const repo = makeRepo('untagged-project');
    try {
      const defaults = inferReleaseProvenanceDefaults(repo);
      expect(defaults.production_refs).toEqual(['refs/tags/v*']);
      expect(defaults.integration_refs).toEqual(['origin/main']);
    } finally {
      fs.rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  });

  it('prefers origin branch defaults when an origin remote exists but has not been fetched', () => {
    const repo = makeRepo('fresh-origin-project');
    try {
      removeRemoteTrackingRefs(repo);

      const defaults = inferReleaseProvenanceDefaults(repo);

      expect(defaults.integration_refs).toEqual(['origin/main']);
    } finally {
      fs.rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  });

  it('fills only missing release provenance settings', () => {
    const repo = makeRepo('myco');
    try {
      git(repo, ['tag', 'myco/v1.2.3']);
      const config = MycoConfigSchema.parse({
        version: 3,
        release_provenance: {
          production_refs: ['refs/tags/custom/v*'],
          integration_refs: [],
          github: { repo: '' },
        },
      });

      const updated = withInferredReleaseProvenanceDefaults(config, repo);

      expect(updated.release_provenance.production_refs).toEqual(['refs/tags/custom/v*']);
      expect(updated.release_provenance.integration_refs).toEqual(['origin/main']);
      expect(updated.release_provenance.github.repo).toBe('goondocks-co/myco');
    } finally {
      fs.rmSync(path.dirname(repo), { recursive: true, force: true });
    }
  });
});
