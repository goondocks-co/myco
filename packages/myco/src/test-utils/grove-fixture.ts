/**
 * Multi-Grove fixture helper for migration tests.
 *
 * Creates a sandboxed MYCO_HOME with grove.yaml files and per-project
 * temp dirs holding myco.yaml / local.yaml. Restores MYCO_HOME after the
 * test callback returns (or throws).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { MYCO_HOME_ENV } from '../grove/paths.js';
import type { MachineState } from '../migrations/agent-config-grove-promotion.js';

export interface FixtureProjectInput {
  id: string;
  myco?: Record<string, unknown>;
  local?: Record<string, unknown>;
}

export interface FixtureGroveInput {
  id: string;
  grove_yaml?: Record<string, unknown>;
  projects: FixtureProjectInput[];
}

export interface FixtureMachineInput {
  groves: FixtureGroveInput[];
}

export interface FixtureProjectHandle {
  id: string;
  vaultDir: string;
}

export interface FixtureGroveHandle {
  id: string;
  grovePath: string;
  projects: FixtureProjectHandle[];
}

export interface FixtureMachineHandle {
  mycoHome: string;
  groves: FixtureGroveHandle[];
}

export async function withMultiGroveFixture(
  input: FixtureMachineInput,
  fn: (handle: FixtureMachineHandle) => Promise<void> | void,
): Promise<void> {
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fixture-home-'));
  const projectDirs: string[] = [];
  const previousMycoHome = process.env[MYCO_HOME_ENV];

  try {
    process.env[MYCO_HOME_ENV] = mycoHome;

    const groves: FixtureGroveHandle[] = [];

    for (const groveInput of input.groves) {
      const groveDir = path.join(mycoHome, 'groves', groveInput.id);
      fs.mkdirSync(groveDir, { recursive: true });

      const groveYaml = groveInput.grove_yaml ?? {};
      fs.writeFileSync(path.join(groveDir, 'grove.yaml'), YAML.stringify(groveYaml), 'utf-8');

      const projects: FixtureProjectHandle[] = [];

      for (const projectInput of groveInput.projects) {
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fixture-proj-'));
        projectDirs.push(projectRoot);
        const vaultDir = path.join(projectRoot, '.myco');
        fs.mkdirSync(vaultDir, { recursive: true });

        const mycoDoc = projectInput.myco ?? { version: 3 };
        if (!('version' in mycoDoc)) {
          (mycoDoc as Record<string, unknown>)['version'] = 3;
        }
        fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(mycoDoc), 'utf-8');

        if (projectInput.local !== undefined) {
          fs.writeFileSync(path.join(vaultDir, 'local.yaml'), YAML.stringify(projectInput.local), 'utf-8');
        }

        projects.push({ id: projectInput.id, vaultDir });
      }

      groves.push({ id: groveInput.id, grovePath: groveDir, projects });
    }

    const handle: FixtureMachineHandle = { mycoHome, groves };
    await fn(handle);
  } finally {
    if (previousMycoHome === undefined) {
      delete process.env[MYCO_HOME_ENV];
    } else {
      process.env[MYCO_HOME_ENV] = previousMycoHome;
    }

    for (const dir of projectDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(mycoHome, { recursive: true, force: true });
  }
}

/** Build a MachineState from a FixtureMachineHandle for migration tests. */
export function handleToMachineState(handle: FixtureMachineHandle): MachineState {
  return {
    groves: handle.groves.map((g) => ({
      id: g.id,
      grovePath: g.grovePath,
      projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
    })),
  };
}
