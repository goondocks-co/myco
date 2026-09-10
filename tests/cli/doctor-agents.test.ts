/**
 * `myco doctor` answers symbiont detection on demand — the behaviour, not the
 * wiring.
 *
 * Detection is one of the three machine-side needs the 1.4 JobRunner woke up to
 * do (`symbiont-detection`), and in 2.0 it is a verb someone runs. The static
 * half of that claim — the verb reaches the detection module — is
 * `tests/meta/member-no-timer.test.ts`; a static edge survives a body replaced by
 * an early return, so this drives the verb's own check surface over a project
 * tree and asserts it reports the agent it found.
 *
 * Read-only: `runChecks` probes and `fix` is the path that writes. HOME and
 * MYCO_HOME are sandboxed per test, so the probe reads no real machine state, and
 * the agent is detectable the way a real one is — by its config directory
 * existing beside the project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DoctorCheck, runChecks } from '@myco/cli/doctor';
import { detectSymbionts, loadManifests } from '@myco/symbionts/detect';
import { clearGroveRegistryCaches, createGrove, registerProjectInGrove } from '@myco/grove/registry';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

/** The config directory whose presence makes an agent detectable, by manifest name. */
const CONFIG_DIR: Readonly<Record<string, string>> = { 'claude-code': '.claude' };

let home: string;
let previousHome: string | undefined;
let previousMycoHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-agents-'));
  previousHome = process.env.HOME;
  previousMycoHome = process.env.MYCO_HOME;
  process.env.HOME = home;
  process.env.MYCO_HOME = path.join(home, '.myco');
  clearGroveRegistryCaches();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previousMycoHome;
  clearGroveRegistryCaches();
});

/**
 * A project the way provisioning leaves one: a vault config, a Grove binding and
 * a registry entry, with the agent's config directory beside it when one is
 * installed. The checks read a registered project; an unregistered root is a
 * different answer and a different test.
 */
function project(agent: string): string {
  const root = fs.mkdtempSync(path.join(home, 'proj-'));
  const vaultDir = path.join(root, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');
  const mycoHome = process.env.MYCO_HOME!;
  const grove = createGrove('agents', mycoHome);
  const manifest = ensureProjectManifest(vaultDir, {
    projectName: 'agents', groveId: grove.id, groveSlug: grove.slug, groveName: grove.name,
  });
  registerProjectInGrove(grove.id, {
    projectId: manifest.project.id, projectName: 'agents', projectRoot: root, bindingId: manifest.grove?.binding_id,
  }, mycoHome);
  expect(loadManifests().find((m) => m.name === agent), `manifest ${agent} should exist`).toBeDefined();
  fs.mkdirSync(path.join(root, CONFIG_DIR[agent]!), { recursive: true });
  return vaultDir;
}

/** The Agents block: the row that carries the name, and the unnamed rows that continue it. */
function agentReport(checks: readonly DoctorCheck[]): string {
  const first = checks.findIndex((c) => c.name === 'Agents');
  if (first === -1) return '';
  const rows: string[] = [];
  for (let i = first; i < checks.length && (i === first || checks[i]!.name === ''); i += 1) rows.push(checks[i]!.detail);
  return rows.join(' | ');
}

describe('myco doctor and the agents on this machine', () => {
  it('finds an installed agent by its config directory and names it in the report', async () => {
    const vaultDir = project('claude-code');
    // The detection the verb is expected to perform, stated independently of it.
    expect(detectSymbionts(path.dirname(vaultDir)).map((d) => d.manifest.name)).toContain('claude-code');

    // The machine running this may carry agents of its own, so the assertion is
    // about the one this project installed rather than about the list's length.
    const report = agentReport(await runChecks(vaultDir, testPerUserLockNamespace));
    expect(report).toContain('Claude Code');
    expect(report).not.toContain('No symbionts detected');
  });
});
