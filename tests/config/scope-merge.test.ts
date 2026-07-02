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

  it('grove.yaml no longer prunes agent.semantic_write_check_enabled (regression: dogfood gotcha)', () => {
    // Prior to Task 5, this field lived only in AgentBaseSchema with no
    // SCOPE_REGISTRY entry, so the scope-aware merge silently dropped any
    // value set in grove.yaml before it ever reached the resolved config.
    fs.writeFileSync(
      path.join(home.path, 'groves', GROVE, 'grove.yaml'),
      'agent:\n  semantic_write_check_enabled: true\n',
      'utf-8',
    );
    invalidateMergedConfigCache();
    const cfg = loadMergedConfig(vault, { groveId: GROVE });
    expect(cfg.agent.semantic_write_check_enabled).toBe(true);
  });

  it('local.yaml overrides the grove value for agent.semantic_write_check_enabled (staging path)', () => {
    fs.writeFileSync(
      path.join(home.path, 'groves', GROVE, 'grove.yaml'),
      'agent:\n  semantic_write_check_enabled: false\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(vault, 'local.yaml'), 'agent:\n  semantic_write_check_enabled: true\n', 'utf-8');
    invalidateMergedConfigCache();
    const cfg = loadMergedConfig(vault, { groveId: GROVE });
    expect(cfg.agent.semantic_write_check_enabled).toBe(true);
  });
});
