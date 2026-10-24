/** The release recipe classifies channels and publishes complete GitHub distributions. */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const WORKFLOW = path.join(import.meta.dir, '..', '..', '.github', 'workflows', 'publish.yml');
type Step = { name?: string; run?: string; uses?: string };
const workflow = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8')) as { on: { push: { tags: string[] } }; jobs: Record<string, { steps: Step[] }> };
const step = (job: string, name: string): string => {
  const found = workflow.jobs[job].steps.find((s) => s.name === name)?.run;
  if (found === undefined) throw new Error(`no step "${name}" in ${job}`);
  return found;
};

/** Run the validate-tag step for `tag`: its exit status and what it writes to GITHUB_OUTPUT. */
function runClassify(tag: string): { status: number | null; outputs: Record<string, string>; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-'));
  const out = path.join(dir, 'output');
  fs.writeFileSync(out, '');
  const result = spawnSync('bash', ['-c', step('validate-tag', 'Extract package and version from tag')], {
    env: { PATH: process.env.PATH, EVENT_NAME: 'push', TAG_NAME: tag, GITHUB_OUTPUT: out }, encoding: 'utf8',
  });
  const text = fs.readFileSync(out, 'utf8').trim();
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, outputs: Object.fromEntries(text ? text.split('\n').map((line) => line.split('=') as [string, string]) : []) };
}

/** What the validate-tag step writes to GITHUB_OUTPUT for a tag it accepts. */
function classify(tag: string): Record<string, string> {
  const result = runClassify(tag);
  expect(result.status).toBe(0);
  return result.outputs;
}

describe('a Myco 2.0 prerelease', () => {
  it('checks out the shared policy before validating a tag', () => {
    const steps = workflow.jobs['validate-tag'].steps;
    const checkout = steps.findIndex(s => s.uses?.startsWith('actions/checkout@'));
    const validation = steps.findIndex(s => s.name === 'Extract package and version from tag');
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeLessThan(validation);
  });

  it('is triggered by its tag, and classed as a beta prerelease', () => {
    expect(workflow.on.push.tags).toContain('myco/v*.*.*-*');
    expect(classify('myco/v2.0.0-beta.1')).toMatchObject({ version: '2.0.0-beta.1', is_prerelease: 'true', release_channel: 'beta', tag_name: 'myco/v2.0.0-beta.1' });
    expect(classify('myco/v2.0.0')).toMatchObject({ is_prerelease: 'false', release_channel: 'stable' });
  });

  it('is any hyphenated version, in its release channel and never latest; an unknown or malformed one fails the run', () => {
    expect(classify('myco/v2.0.0-alpha.3')).toMatchObject({ is_prerelease: 'true', release_channel: 'alpha' });
    expect(classify('myco/v2.0.0-rc.1')).toMatchObject({ is_prerelease: 'true', release_channel: 'rc' });
    for (const tag of ['myco-shared/v2.0.0-beta.2', 'myco/v2.0.0-alpha.foo', 'myco/v2.0.0-beta.foo', 'myco/v2.0.0-alpha.01', 'myco/v2.0.0-dev.1', 'myco/v2.0.0-preview', 'myco/v2.0.0-beta.1+build', 'myco/v2.0', 'myco/v2.0.0.1', 'myco/v2.0.0garbage']) {
      const result = runClassify(tag);
      expect({ tag, status: result.status, release_channel: result.outputs.release_channel ?? 'none' }).toEqual({ tag, status: 1, release_channel: 'none' });
    }
  });

  it('carries release notes that install Myco 2.0, not 1.4', () => {
    const notes = step('create-release', 'Generate release notes');
    expect(notes).toContain("curl --proto '\"'\"'=https'\"'\"' --tlsv1.2 -fsSL https://myco.sh/install.sh | MYCO_CHANNEL=${{ needs.validate-tag.outputs.release_channel }} sh");
    expect(notes).toContain('myco login <your-myco-address>');
    expect(notes).toContain('${DISPLAY_NAME} · ${RANGE_BLURB}');
    expect(notes).not.toContain('PACKAGE_NAME');
    expect(notes).toContain('Fresh default installs choose 2.x stable, then beta, then alpha, never 1.4');
    expect(notes).toContain('Explicit stable selects releases only');
    expect(notes).toContain('Cut the stable/next tag first');
    expect(notes).not.toContain('stable channel only while');
    expect(notes).toContain('docs/upgrade.md#upgrading-from-myco-14');
    expect(notes).not.toMatch(/npm\s+(?:install|update)\b/);
  });

  it('is a GitHub prerelease that is never marked latest', () => {
    expect(step('create-release', 'Create or update GitHub Release')).toContain('create_args+=(--prerelease)');
    expect(step('create-release', 'Publish the GitHub Release')).toContain('publish_args+=(--prerelease --latest=false)');
  });

  it('requires all five binaries and SHA256SUMS before creating and publishing a draft', () => {
    const names = ['myco-darwin-arm64', 'myco-darwin-x64', 'myco-linux-x64', 'myco-linux-arm64', 'myco-windows-x64.exe', 'SHA256SUMS'];
    const defects = ['none', ...names.map(name => `missing:${name}`), 'tampered', 'missing-entry', 'duplicate-entry', 'substituted-entry', 'extra-entry', 'malformed-entry', 'malformed-separator'];
    for (const state of ['absent', 'draft', 'published']) for (const defect of defects) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-order-'));
      try {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const log = path.join(dir, 'gh.log');
        fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$*" >> '${log}'
if [ "$1 $2" = "release view" ]; then echo ${state === 'draft' ? 'true' : 'false'}; exit ${state === 'absent' ? 1 : 0}; fi
`, { mode: 0o755 });
        if (spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0) {
          fs.writeFileSync(path.join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
        }
        fs.mkdirSync(path.join(dir, 'scripts'));
        fs.copyFileSync(path.resolve('scripts/release-assets.sh'), path.join(dir, 'scripts/release-assets.sh'));
        const distribution = path.join(dir, 'release-files');
        fs.mkdirSync(distribution);
        for (const name of names.slice(0, -1)) fs.writeFileSync(path.join(distribution, name), name);
        fs.writeFileSync(path.join(distribution, 'SHA256SUMS'), names.slice(0, -1).map(name =>
          `${crypto.createHash('sha256').update(name).digest('hex')}  ${name}\n`).join(''));
        const manifest = path.join(distribution, 'SHA256SUMS');
        const entries = fs.readFileSync(manifest, 'utf8').trim().split('\n');
        const windows = entries.find(line => line.endsWith('  myco-windows-x64.exe'))!;
        if (defect.startsWith('missing:')) fs.unlinkSync(path.join(distribution, defect.slice('missing:'.length)));
        if (defect === 'tampered') fs.appendFileSync(path.join(distribution, 'myco-linux-x64'), 'different bytes');
        if (defect === 'missing-entry') fs.writeFileSync(manifest, entries.filter(line => line !== windows).join('\n') + '\n');
        if (defect === 'duplicate-entry') fs.appendFileSync(manifest, windows + '\n');
        if (defect === 'substituted-entry') fs.writeFileSync(manifest, entries.map(line => line.endsWith('  myco-linux-x64') ? windows : line).join('\n') + '\n');
        if (defect === 'extra-entry') fs.appendFileSync(manifest, 'invalid  extra-binary');
        if (defect === 'malformed-entry') fs.writeFileSync(manifest, entries.map(line => line === windows ? 'invalid  myco-windows-x64.exe' : line).join('\n') + '\n');
        if (defect === 'malformed-separator') fs.writeFileSync(manifest, entries.map(line => line === windows ? line.replace('  ', ' ') : line).join('\n') + '\n');
        fs.writeFileSync(path.join(dir, 'release-notes.md'), 'notes');
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAG_NAME: 'myco/v2.0.0-beta.1', IS_PRERELEASE: 'true',
          RELEASE_TITLE: 'Myco 2.0.0-beta.1', GH_TOKEN: 'fixture', GITHUB_OUTPUT: path.join(dir, 'outputs') };
        const order = ['Collect release assets', 'Create or update GitHub Release', 'Publish the GitHub Release'];
        const steps = workflow.jobs['create-release'].steps;
        const indices = order.map(name => steps.findIndex(one => one.name === name));
        expect(indices.every(index => index >= 0)).toBe(true);
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
        for (const index of indices) {
          expect(steps[index]).not.toHaveProperty('continue-on-error');
          expect(steps[index]).not.toHaveProperty('if');
        }
        let status: number | null = 0;
        for (const name of order) {
          const ran = spawnSync('bash', ['-e', '-c', step('create-release', name)], { cwd: dir, env, encoding: 'utf8' });
          status = ran.status;
          if (status !== 0) break;
          if (fs.existsSync(env.GITHUB_OUTPUT) && fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').includes('published=true')) {
            Object.assign(env, { RELEASE_PUBLISHED: 'true' });
          }
        }
        const allCalls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
        if (defect !== 'none') { expect(status, `${state}: ${defect}`).not.toBe(0); expect(allCalls).toEqual([]); continue; }
        const calls = allCalls.filter(call => !call.startsWith('release view '));
        expect(status).toBe(0);
        if (state === 'published') { expect(calls).toEqual([]); continue; }
        const attaching = calls.find(call => /release (?:create|upload) /.test(call))!;
        for (const name of names) expect(attaching).toContain(`release-files/${name}`);
        expect(calls[0]).toContain(state === 'draft' ? 'release edit' : 'release create');
        if (state === 'absent') expect(calls[0]).toContain('--draft');
        expect(calls.at(-1)).toBe('release edit myco/v2.0.0-beta.1 --draft=false --prerelease --latest=false');
        expect(calls).toHaveLength(state === 'draft' ? 3 : 2);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

});


describe('Myco 2.0 update guidance', () => {
  it('describes daily helper checks and manual commands without a member service', () => {
    const docs = fs.readFileSync(path.resolve('docs/upgrade.md'), 'utf8');
    const memberGuide = docs.split('## Myco 1.4 updates')[0];
    expect(memberGuide).toContain('about once a day in the default home');
    expect(memberGuide).toContain('myco member status');
    expect(memberGuide).toContain('myco update --automatic off');
    expect(memberGuide).toContain('myco update --automatic on');
    expect(memberGuide).not.toContain('There is no automatic-update off setting');
    expect(memberGuide).toContain('runs no member update timer or local service');
    expect(memberGuide).toContain('myco update --check');
    expect(memberGuide).toContain('myco update --channel beta');
    expect(memberGuide).not.toMatch(/updates itself|automatically stages|idle window|self-updat/i);
    expect(docs).toContain('Myco 1.4 retains its local service and background updater');
  });
});
