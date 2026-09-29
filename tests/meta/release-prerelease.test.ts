/**
 * The release workflow can cut a Myco 2.0 prerelease without it becoming the
 * latest anything: a `myco/v2.0.0-beta.1` tag is a GitHub prerelease that is
 * never marked latest, and every npm publish goes out under the `beta`
 * dist-tag, so npm `latest` stays where it is for the core package and its
 * five platform packages.
 *
 * The tag-classification step is run for real, lifted out of the workflow.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const WORKFLOW = path.join(import.meta.dir, '..', '..', '.github', 'workflows', 'publish.yml');
type Step = { name?: string; run?: string };
const workflow = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8')) as { on: { push: { tags: string[] } }; jobs: Record<string, { steps: Step[] }> };
const step = (job: string, name: string): string => {
  const found = workflow.jobs[job].steps.find((s) => s.name === name)?.run;
  if (found === undefined) throw new Error(`no step "${name}" in ${job}`);
  return found;
};

/** What the validate-tag step writes to GITHUB_OUTPUT for `tag`. */
function classify(tag: string): Record<string, string> {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-')), 'output');
  fs.writeFileSync(out, '');
  const result = spawnSync('bash', ['-c', step('validate-tag', 'Extract package and version from tag')], {
    env: { PATH: process.env.PATH, TAG_NAME: tag, GITHUB_OUTPUT: out }, encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => line.split('=') as [string, string]));
}

describe('a Myco 2.0 prerelease', () => {
  it('is triggered by its tag, and classed as a beta prerelease', () => {
    expect(workflow.on.push.tags).toContain('myco/v*.*.*-*');
    expect(classify('myco/v2.0.0-beta.1')).toMatchObject({ version: '2.0.0-beta.1', is_prerelease: 'true', npm_tag: 'beta', package_name: '@goondocks/myco' });
    expect(classify('myco/v2.0.0')).toMatchObject({ is_prerelease: 'false', npm_tag: 'latest' });
  });

  it('is a GitHub prerelease that is never marked latest', () => {
    const release = step('create-release', 'Create or update GitHub Release');
    expect(release).toContain('edit_args+=(--prerelease --latest=false)');
    expect(release).toContain('create_args+=(--prerelease --latest=false)');
  });

  it('publishes every npm package under the tag it was classed with, never a bare publish', () => {
    const publish = step('publish', 'Publish package');
    const publishes = publish.split('\n').filter((line) => /\bnpm(@latest)? publish\b/.test(line));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) expect(line).toContain('--tag "$NPM_TAG"');
    const env = (workflow.jobs.publish.steps.find((s) => s.name === 'Publish package') as { env?: Record<string, string> }).env;
    expect(env?.NPM_TAG).toBe('${{ needs.validate-tag.outputs.npm_tag }}');
  });
});
