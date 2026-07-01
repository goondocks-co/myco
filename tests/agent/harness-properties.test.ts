/**
 * Harness property checks — structural invariants verified without
 * executing the agent.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
// Mock tryEmbed to return null immediately — no real embedding provider in tests
mock.module('@myco/intelligence/embed-query.js', () => ({
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

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
const TEST_AGENT_ID = 'test-agent-props';
const TEST_RUN_ID = 'run-props-001';

describe('harness properties', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  const defsDir = resolveDefinitionsDir();
  const tasksDir = resolve(defsDir, 'tasks');
  const yamlFiles = readdirSync(tasksDir).filter(f => f.endsWith('.yaml'));

  // Parse all YAML files once — reused across all describe blocks
  const parsedTasks = new Map(
    yamlFiles.map(file => [file, parseYaml(readFileSync(resolve(tasksDir, file), 'utf-8'))] as const),
  );

  // Create tools once — reused across annotation and YAML validation tests
  const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
  const toolNameSet = new Set(tools.map(t => t.name));

  // ---------------------------------------------------------------------------
  // Area 1: Tool Annotations
  // ---------------------------------------------------------------------------

  describe('tool annotations', () => {
    it('every tool has an annotations object', () => {
      expect(tools).toHaveLength(VAULT_TOOL_COUNT);
      for (const t of tools) {
        expect(
          t.annotations,
          `Tool "${t.name}" is missing annotations — add them in the tool definition`,
        ).toBeDefined();
      }
    });

    it('read tools are annotated readOnlyHint: true', () => {
      const readToolNames = [
        'vault_unprocessed', 'vault_batches', 'vault_session_summary_material', 'vault_spores', 'vault_sessions',
        'vault_search_fts', 'vault_search_semantic', 'vault_release_state', 'vault_state',
        'vault_edges', 'vault_read_digest', 'vault_skill_survey_prepare',
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

    it('skill-survey write tools are annotated idempotentHint: false (each call mutates state)', () => {
      // These three tools each write to agent_state (or to skill_candidates
      // via apply_reconciliation). MCP auto-retry layers must NOT treat
      // a repeat call as a safe replay, so the hint must explicitly say
      // "calling twice is NOT the same as calling once".
      const nonIdempotentToolNames = [
        'vault_skill_survey_bundle_decisions',
        'vault_skill_survey_reconciliation_plan',
        'vault_skill_survey_apply_reconciliation',
      ];
      for (const name of nonIdempotentToolNames) {
        const t = tools.find(tool => tool.name === name);
        expect(t, `Skill-survey write tool "${name}" not found`).toBeDefined();
        expect(
          t!.annotations?.idempotentHint,
          `Skill-survey write tool "${name}" must have idempotentHint: false — repeat calls mutate state`,
        ).toBe(false);
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
        const parsed = parsedTasks.get(file)!;

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
            for (const phase of parsed.phases) {
              for (const toolName of phase.tools ?? []) {
                expect(
                  toolNameSet.has(toolName),
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
    const UNCONDITIONAL_ALLOWLIST = [
      'vault-evolve',
      'skill-survey',
      // Self-gated by buildScheduledCortexInstruction(), which compares the
      // stored input hash against the newly assembled payload before dispatch.
      'cortex-instructions',
      // Self-gated by gatherCanopyMapContext(): skips when canopy injection
      // is disabled, when no rows have llm_description, or when the
      // inputs_hash matches the prior canopy_maps row. The schedule fires
      // unconditionally; the gather phase absorbs the no-op cases before
      // any LLM cost.
      'canopy-map',
    ];

    for (const file of yamlFiles) {
      const parsed = parsedTasks.get(file)!;
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
    // Derive read-only phases from YAML readOnly: true — no hardcoded map.
    // New phases with readOnly: true are automatically covered.
    const destructiveToolNames = new Set(
      tools.filter(t => t.annotations?.destructiveHint).map(t => t.name),
    );
    const nonReadOnlyToolNames = new Set(
      tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name),
    );

    for (const file of yamlFiles) {
      const parsed = parsedTasks.get(file)!;
      const taskName = parsed.name as string;

      if (parsed.phases) {
        const roPhases = (parsed.phases as Array<{ name: string; tools: string[]; readOnly?: boolean }>)
          .filter(p => p.readOnly);

        for (const phase of roPhases) {
          it(`${taskName}/${phase.name} has no destructive tools`, () => {
            const badTools = phase.tools.filter(t => destructiveToolNames.has(t));
            expect(
              badTools,
              `Read-only phase "${phase.name}" in ${taskName} has destructive tools: ${badTools.join(', ')}`,
            ).toHaveLength(0);
          });

          it(`${taskName}/${phase.name} only lists read-only tools`, () => {
            const badTools = phase.tools.filter(t => nonReadOnlyToolNames.has(t));
            expect(
              badTools,
              `Read-only phase "${phase.name}" in ${taskName} lists tools without readOnlyHint: true: ${badTools.join(', ')}`,
            ).toHaveLength(0);
          });
        }
      }
    }

    it('treats vault_report as read-only observability', () => {
      const reportTool = tools.find(t => t.name === 'vault_report');
      expect(reportTool?.annotations?.readOnlyHint).toBe(true);
    });

    it('at least one phase across all tasks is marked readOnly', () => {
      let readOnlyCount = 0;
      for (const parsed of parsedTasks.values()) {
        if (parsed.phases) {
          readOnlyCount += (parsed.phases as Array<{ readOnly?: boolean }>).filter(p => p.readOnly).length;
        }
      }
      expect(readOnlyCount, 'No readOnly phases found — was the flag removed?').toBeGreaterThan(0);
    });
  });
});
