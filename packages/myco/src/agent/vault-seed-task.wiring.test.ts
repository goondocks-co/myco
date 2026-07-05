import { describe, expect, test } from 'bun:test';
import { loadAgentTasks, resolveDefinitionsDir } from './loader.js';
import { PHASE_POSTCONDITION_KINDS } from './phase-postcondition-kinds.js';
import { computeWaves } from './wave-computation.js';

/**
 * vault-seed.yaml phase-graph wiring coverage. Asserts each phase binds
 * to the correct postCondition kind: postCondition checkers never receive
 * the phase name, so a kind bound to the wrong phase (e.g. a copy-paste
 * leaving `vault-seed-digest-5000` on `digest-10000`) cannot self-verify
 * at runtime and must be caught here instead.
 */
describe('vault-seed.yaml phase wiring', () => {
  const tasks = loadAgentTasks(resolveDefinitionsDir());
  const vaultSeed = tasks.find((t) => t.name === 'vault-seed');

  test('vault-seed task loads and validates against AgentTaskSchema', () => {
    expect(vaultSeed).toBeDefined();
  });

  function phase(name: string) {
    const found = vaultSeed?.phases?.find((p) => p.name === name);
    expect(found).toBeDefined();
    return found!;
  }

  test('every postCondition kind used in vault-seed.yaml is a registered kind', () => {
    const used = (vaultSeed?.phases ?? [])
      .map((p) => p.postCondition)
      .filter((k) => k !== undefined);
    expect(used.length).toBeGreaterThan(0);
    for (const kind of used) {
      expect(PHASE_POSTCONDITION_KINDS as readonly string[]).toContain(kind);
    }
  });

  test('seed-spores binds to vault-seed-spores (not a digest kind)', () => {
    expect(phase('seed-spores').postCondition).toBe('vault-seed-spores');
  });

  test('digest-10000 binds to vault-seed-digest-10000 — not the 5000 or 1500 kind', () => {
    expect(phase('digest-10000').postCondition).toBe('vault-seed-digest-10000');
  });

  test('digest-5000 binds to vault-seed-digest-5000 — not the 10000 or 1500 kind', () => {
    expect(phase('digest-5000').postCondition).toBe('vault-seed-digest-5000');
  });

  test('digest-1500 binds to vault-seed-digest-1500 — not the 10000 or 5000 kind', () => {
    expect(phase('digest-1500').postCondition).toBe('vault-seed-digest-1500');
  });

  test('report phase has no postCondition (not part of the checked contract)', () => {
    expect(phase('report').postCondition).toBeUndefined();
  });

  test('reseed-check has no postCondition (its output is metadata + report, not a mechanical gate target)', () => {
    expect(phase('reseed-check').postCondition).toBeUndefined();
  });

  test('no two phases share the same postCondition kind (copy-paste guard)', () => {
    const used = (vaultSeed?.phases ?? [])
      .map((p) => p.postCondition)
      .filter((k) => k !== undefined);
    const unique = new Set(used);
    expect(unique.size).toBe(used.length);
  });

  describe('gateOnPriorMetadata fan-out', () => {
    const gatedPhaseNames = ['orient', 'explore-themes', 'seed-spores', 'digest-10000', 'digest-5000', 'digest-1500'];

    for (const name of gatedPhaseNames) {
      test(`${name} gates on reseed-check.seedDecision === "proceed"`, () => {
        const gate = phase(name).gateOnPriorMetadata;
        expect(gate).toEqual({ phase: 'reseed-check', key: 'seedDecision', equals: 'proceed' });
      });
    }

    test('report is NOT gated — it must run on both the skip and proceed paths', () => {
      expect(phase('report').gateOnPriorMetadata).toBeUndefined();
    });

    test('reseed-check itself is not gated (it is the root decision phase)', () => {
      expect(phase('reseed-check').gateOnPriorMetadata).toBeUndefined();
    });
  });

  test('orient depends on reseed-check (load-bearing: without this, orient shares reseed-check\'s wave and defaults to skip even on a cold vault)', () => {
    expect(phase('orient').dependsOn).toContain('reseed-check');
  });

  test('report depends on reseed-check so it always has the decision phase\'s result available', () => {
    expect(phase('report').dependsOn).toContain('reseed-check');
  });

  test('reseed-check is a root phase (no dependsOn) so it runs in wave 1 alongside no gate that could block it', () => {
    expect(phase('reseed-check').dependsOn ?? []).toHaveLength(0);
  });

  test('computeWaves places reseed-check strictly before orient — without dependsOn: [reseed-check], both are root phases that would land in the SAME wave, and orient\'s gate would then read no upstream result and default to skip even on a cold vault', () => {
    const waves = computeWaves(vaultSeed?.phases ?? []);
    const waveIndexOf = (name: string) => waves.findIndex((wave) => wave.some((p) => p.name === name));

    const reseedCheckWave = waveIndexOf('reseed-check');
    const orientWave = waveIndexOf('orient');

    expect(reseedCheckWave).toBeGreaterThanOrEqual(0);
    expect(orientWave).toBeGreaterThan(reseedCheckWave);
  });

  test('computeWaves places digest-10000/5000/1500 in the same wave (parallel), all after seed-spores', () => {
    const waves = computeWaves(vaultSeed?.phases ?? []);
    const waveIndexOf = (name: string) => waves.findIndex((wave) => wave.some((p) => p.name === name));

    const seedSporesWave = waveIndexOf('seed-spores');
    const digest10000Wave = waveIndexOf('digest-10000');
    const digest5000Wave = waveIndexOf('digest-5000');
    const digest1500Wave = waveIndexOf('digest-1500');

    expect(digest10000Wave).toBeGreaterThan(seedSporesWave);
    expect(digest10000Wave).toBe(digest5000Wave);
    expect(digest10000Wave).toBe(digest1500Wave);
  });
});
