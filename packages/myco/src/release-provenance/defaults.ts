import path from 'node:path';
import type { MycoConfig, ReleaseProvenanceConfig } from '@myco/config/schema.js';
import { runGit } from './git-cmd.js';
import { GITHUB_TOKEN_ENV } from './github.js';

const STANDARD_RELEASE_TAG_REF = 'refs/tags/v*';
const COMMON_INTEGRATION_BRANCHES = ['main', 'master', 'trunk', 'develop'] as const;

export function inferReleaseProvenanceDefaults(projectRoot: string): ReleaseProvenanceConfig {
  const current = isGitRepository(projectRoot);
  const productionRefs = current
    ? [inferProductionRef(projectRoot)]
    : [];

  return {
    enabled: true,
    production_refs: productionRefs,
    integration_refs: current ? inferIntegrationRefs(projectRoot) : [],
    reconcile_interval_minutes: 15,
    production_debug_include_unknown: true,
    github: {
      repo: current ? inferGithubRepo(projectRoot) : '',
      token_env: GITHUB_TOKEN_ENV,
      max_lookups_per_run: 20,
    },
    package_map: [],
  };
}

export function withInferredReleaseProvenanceDefaults(config: MycoConfig, projectRoot: string): MycoConfig {
  if (!isGitRepository(projectRoot)) return config;

  const inferred = inferReleaseProvenanceDefaults(projectRoot);
  const current = config.release_provenance;
  const next: ReleaseProvenanceConfig = {
    ...current,
    github: { ...current.github },
  };

  let changed = false;
  if (next.production_refs.length === 0 && inferred.production_refs.length > 0) {
    next.production_refs = inferred.production_refs;
    changed = true;
  }
  if (next.integration_refs.length === 0 && inferred.integration_refs.length > 0) {
    next.integration_refs = inferred.integration_refs;
    changed = true;
  }
  if (!next.github.repo && inferred.github.repo) {
    next.github.repo = inferred.github.repo;
    changed = true;
  }

  return changed ? { ...config, release_provenance: next } : config;
}

function isGitRepository(projectRoot: string): boolean {
  const result = runGit(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

function inferProductionRef(projectRoot: string): string {
  const projectName = path.basename(projectRoot).toLowerCase();
  const tags = listTagNames(projectRoot).map((tag) => tag.toLowerCase());

  if (projectName && tags.some((tag) => tag.startsWith(`${projectName}/v`))) {
    return `refs/tags/${projectName}/v*`;
  }
  if (projectName && tags.some((tag) => tag.startsWith(`${projectName}-v`))) {
    return `refs/tags/${projectName}-v*`;
  }
  return STANDARD_RELEASE_TAG_REF;
}

function inferIntegrationRefs(projectRoot: string): string[] {
  const originHead = runGit(projectRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.ok && originHead.stdout) return [originHead.stdout.trim()];

  for (const branch of COMMON_INTEGRATION_BRANCHES) {
    if (refExists(projectRoot, `refs/remotes/origin/${branch}`)) return [`origin/${branch}`];
  }
  if (hasOriginRemote(projectRoot)) {
    for (const branch of COMMON_INTEGRATION_BRANCHES) {
      if (refExists(projectRoot, `refs/heads/${branch}`)) return [`origin/${branch}`];
    }
    return ['origin/main'];
  }
  for (const branch of COMMON_INTEGRATION_BRANCHES) {
    if (refExists(projectRoot, `refs/heads/${branch}`)) return [branch];
  }
  return ['origin/main'];
}

function inferGithubRepo(projectRoot: string): string {
  const origin = runGit(projectRoot, ['remote', 'get-url', 'origin']);
  if (origin.ok && origin.stdout) return parseGithubRepo(origin.stdout.trim()) ?? '';

  const remotes = runGit(projectRoot, ['remote']);
  if (!remotes.ok) return '';
  for (const remote of remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const url = runGit(projectRoot, ['remote', 'get-url', remote]);
    if (!url.ok || !url.stdout) continue;
    const repo = parseGithubRepo(url.stdout.trim());
    if (repo) return repo;
  }
  return '';
}

function listTagNames(projectRoot: string): string[] {
  const result = runGit(projectRoot, ['tag', '--list']);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function refExists(projectRoot: string, ref: string): boolean {
  return runGit(projectRoot, ['show-ref', '--verify', '--quiet', ref]).ok;
}

function hasOriginRemote(projectRoot: string): boolean {
  const origin = runGit(projectRoot, ['remote', 'get-url', 'origin']);
  return origin.ok && origin.stdout.trim().length > 0;
}

function parseGithubRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.replace(/\/$/, '').replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(trimmed);
  if (ssh) return ssh[1] ?? null;

  const sshUrl = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/.exec(trimmed);
  if (sshUrl) return sshUrl[1] ?? null;

  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(trimmed);
  if (https) return https[1] ?? null;

  return null;
}
