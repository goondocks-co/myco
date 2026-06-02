import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveMachineConfig, loadMergedConfig, invalidateMergedConfigCache } from '../../packages/myco/src/config/loader';
import { useIsolatedHome } from '../support/isolated-home';

describe('scope-aware merge', () => {
  const home = useIsolatedHome('myco-scope-merge-');
  // Must match grove_<32 lowercase hex> (assertGroveEraId). "5c09e" ≈ "scope".
  const GROVE = 'grove_5c09e0000000000000000000000000ab';
  let vault: string;

  beforeEach(() => {
    // machine tier owns capture
    saveMachineConfig({ capture: { plan_dirs: ['machine-dir/'] } } as never);
    // Write the grove config file DIRECTLY (bypass the validating save helper)
    // so it can carry an ILLEGAL machine-scoped `capture` key for the test.
    // Grove config lives at <MYCO_HOME>/groves/<id>/grove.yaml
    // (GROVE_CONFIG_FILENAME), NOT config.yaml — that's the machine file.
    const groveDir = path.join(home.path, 'groves', GROVE);
    fs.mkdirSync(groveDir, { recursive: true });
    fs.writeFileSync(
      path.join(groveDir, 'grove.yaml'),
      'capture:\n  plan_dirs:\n    - STRAY-grove-dir/\nagent:\n  reasoningLevel: high\n',
      'utf-8',
    );
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'scopemerge-vault-'));
    fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\n', 'utf-8');
    invalidateMergedConfigCache();
  });

  it('a stray machine-scoped field in the grove tier cannot override machine', () => {
    const cfg = loadMergedConfig(vault, { groveId: GROVE });
    expect(cfg.capture.plan_dirs).toEqual(['machine-dir/']); // grove stray pruned
    expect(cfg.agent.reasoningLevel).toBe('high');           // legit grove value kept
  });
});
