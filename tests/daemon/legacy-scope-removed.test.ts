import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDaemonServiceState } from '@myco/daemon/service-state.js';

describe('post-Grove daemon scope', () => {
  let savedHome: string | undefined;
  let savedMycoHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedMycoHome = process.env.MYCO_HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
  });

  it('refuses to start in a vault with no Grove binding (no fallback)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'myco-nob-'));
    const vault = path.join(home, 'project', '.myco');
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      path.join(vault, 'project.toml'),
      `[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "test"\n`,
    );
    // Set HOME so resolveMycoHome finds it deterministically
    process.env.HOME = home;
    delete process.env.MYCO_HOME;

    expect(() => resolveDaemonServiceState(vault)).toThrow(/Grove binding/);
  });
});
