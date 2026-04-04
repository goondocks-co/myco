/**
 * Harness property checks — structural invariants verified without
 * executing the agent.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock tryEmbed to return null immediately — no real embedding provider in tests
vi.mock('@myco/intelligence/embed-query.js', () => ({
  tryEmbed: async () => null,
}));

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { setupTestDb, teardownTestDb } from '../helpers/db';
import { createVaultTools, VAULT_TOOL_COUNT } from '@myco/agent/tools.js';
import { AgentTaskSchema } from '@myco/agent/schemas.js';
import { resolveDefinitionsDir } from '@myco/agent/loader.js';
import { computeWaves } from '@myco/agent/wave-computation.js';
import type { PhaseDefinition } from '@myco/agent/types.js';

const TEST_AGENT_ID = 'test-agent-props';
const TEST_RUN_ID = 'run-props-001';

describe('harness properties', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  const defsDir = resolveDefinitionsDir();
  const tasksDir = resolve(defsDir, 'tasks');
  const yamlFiles = readdirSync(tasksDir).filter(f => f.endsWith('.yaml'));

  // ---------------------------------------------------------------------------
  // Area 1: Tool Annotations
  // ---------------------------------------------------------------------------

  describe('tool annotations', () => {
    it('every tool has an annotations object', () => {
      const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
      expect(tools).toHaveLength(VAULT_TOOL_COUNT);
      for (const t of tools) {
        expect(
          t.annotations,
          `Tool "${t.name}" is missing annotations — add them in the tool definition`,
        ).toBeDefined();
      }
    });

    it('read tools are annotated readOnlyHint: true', () => {
      const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
      const readToolNames = [
        'vault_unprocessed', 'vault_spores', 'vault_sessions',
        'vault_search_fts', 'vault_search_semantic', 'vault_state',
        'vault_entities', 'vault_edges', 'vault_read_digest',
      ];
      for (const name of readToolNames) {
        const t = tools.find(tool => tool.name === name);
        expect(t, `Read tool "${name}" not found`).toBeDefined();
        expect(
          t!.annotations?.readOnlyHint,
          `Read tool "${name}" should have readOnlyHint: true`,
        ).toBe(true);
      }
    });

    it('destructive tools are annotated destructiveHint: true', () => {
      const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
      const destructiveToolNames = ['vault_resolve_spore', 'vault_mark_processed'];
      for (const name of destructiveToolNames) {
        const t = tools.find(tool => tool.name === name);
        expect(t, `Destructive tool "${name}" not found`).toBeDefined();
        expect(
          t!.annotations?.destructiveHint,
          `Destructive tool "${name}" should have destructiveHint: true`,
        ).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Area 2: Task YAML Validation
  // ---------------------------------------------------------------------------

  describe('task YAML validation', () => {
    it('has at least one task definition', () => {
      expect(yamlFiles.length).toBeGreaterThan(0);
    });

    for (const file of yamlFiles) {
      describe(file, () => {
        const raw = readFileSync(resolve(tasksDir, file), 'utf-8');
        const parsed = parseYaml(raw);

        it('parses against AgentTaskSchema', () => {
          const result = AgentTaskSchema.safeParse(parsed);
          if (!result.success) {
            throw new Error(
              `${file} failed schema validation:\n${result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
            );
          }
        });

        if (parsed.phases) {
          it('every phase tool name exists in the tool registry', () => {
            const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
            const toolNames = new Set(tools.map(t => t.name));
            for (const phase of parsed.phases) {
              for (const toolName of phase.tools ?? []) {
                expect(
                  toolNames.has(toolName),
                  `Phase "${phase.name}" in ${file} references unknown tool "${toolName}"`,
                ).toBe(true);
              }
            }
          });

          it('no phase maxTurns exceeds task maxTurns', () => {
            const taskMax = parsed.maxTurns;
            if (!taskMax) return;
            for (const phase of parsed.phases) {
              if (phase.maxTurns) {
                expect(
                  phase.maxTurns,
                  `Phase "${phase.name}" in ${file} has maxTurns ${phase.maxTurns} exceeding task maxTurns ${taskMax}`,
                ).toBeLessThanOrEqual(taskMax);
              }
            }
          });
        }
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Area 3: Wave Computation and Scheduling
  // ---------------------------------------------------------------------------

  describe('wave computation', () => {
    it('produces identical output across 100 runs for same input', () => {
      const phases: PhaseDefinition[] = [
        { name: 'a', prompt: '', tools: [], maxTurns: 5, required: true },
        { name: 'b', prompt: '', tools: [], maxTurns: 5, required: true, dependsOn: ['a'] },
        { name: 'c', prompt: '', tools: [], maxTurns: 5, required: true, dependsOn: ['a'] },
        { name: 'd', prompt: '', tools: [], maxTurns: 5, required: true, dependsOn: ['b', 'c'] },
      ];
      const baseline = computeWaves(phases).map(w => w.map(p => p.name).sort());
      for (let i = 0; i < 100; i++) {
        const result = computeWaves(phases).map(w => w.map(p => p.name).sort());
        expect(result).toEqual(baseline);
      }
    });

    it('detects circular dependencies', () => {
      const phases: PhaseDefinition[] = [
        { name: 'a', prompt: '', tools: [], maxTurns: 5, required: true, dependsOn: ['b'] },
        { name: 'b', prompt: '', tools: [], maxTurns: 5, required: true, dependsOn: ['a'] },
      ];
      expect(() => computeWaves(phases)).toThrow(/circular/i);
    });
  });

  describe('scheduled task preConditions', () => {
    const UNCONDITIONAL_ALLOWLIST = ['full-intelligence', 'skill-survey'];

    for (const file of yamlFiles) {
      const raw = readFileSync(resolve(tasksDir, file), 'utf-8');
      const parsed = parseYaml(raw);
      if (parsed.schedule?.enabled) {
        it(`${file}: scheduled task has preCondition or is in allowlist`, () => {
          const isAllowlisted = UNCONDITIONAL_ALLOWLIST.includes(parsed.name);
          const hasPreCondition = parsed.schedule?.preCondition != null;
          expect(
            isAllowlisted || hasPreCondition,
            `${file} is scheduled but has no preCondition and is not in the unconditional allowlist.`,
          ).toBe(true);
        });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Area 4: Read-Only Phase Safety
  // ---------------------------------------------------------------------------

  describe('read-only phase safety', () => {
    const READ_ONLY_PHASES: Record<string, string[]> = {
      'skill-survey': ['explore-spores', 'explore-sessions', 'explore-plans'],
      'full-intelligence': ['read-state'],
      'skill-generate': ['gather'],
    };

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
    const destructiveToolNames = new Set(
      tools.filter(t => t.annotations?.destructiveHint).map(t => t.name),
    );

    for (const file of yamlFiles) {
      const raw = readFileSync(resolve(tasksDir, file), 'utf-8');
      const parsed = parseYaml(raw);
      const taskName = parsed.name as string;
      const roPhases = READ_ONLY_PHASES[taskName];

      if (roPhases && parsed.phases) {
        for (const phaseName of roPhases) {
          const phase = (parsed.phases as Array<{ name: string; tools: string[] }>)
            .find(p => p.name === phaseName);
          if (phase) {
            it(`${taskName}/${phaseName} has no destructive tools`, () => {
              const badTools = phase.tools.filter(t => destructiveToolNames.has(t));
              expect(
                badTools,
                `Read-only phase "${phaseName}" in ${taskName} has destructive tools: ${badTools.join(', ')}`,
              ).toHaveLength(0);
            });
          }
        }
      }
    }
  });
});
