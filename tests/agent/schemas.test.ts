/**
 * Tests for agent Zod schemas.
 *
 * Tests cover:
 * - AgentTaskSchema validates minimal tasks (no optional fields)
 * - AgentTaskSchema validates tasks with phases, execution overrides, contextQueries
 * - AgentTaskSchema rejects tasks missing required fields
 * - ProviderConfigSchema rejects invalid provider types
 * - Backward compatibility: existing YAML task shapes still parse
 * - CURRENT_TASK_SCHEMA_VERSION constant is defined and is a number
 */

import { describe, it, expect } from 'vitest';
import {
  AgentDefinitionSchema,
  PhaseDefinitionSchema,
  AgentTaskSchema,
  ProviderConfigSchema,
  ExecutionConfigSchema,
  ContextQuerySchema,
  CURRENT_TASK_SCHEMA_VERSION,
} from '@myco/agent/schemas.js';

// ---------------------------------------------------------------------------
// CURRENT_TASK_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('CURRENT_TASK_SCHEMA_VERSION', () => {
  it('is defined and is a number', () => {
    expect(typeof CURRENT_TASK_SCHEMA_VERSION).toBe('number');
    expect(CURRENT_TASK_SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ProviderConfigSchema
// ---------------------------------------------------------------------------

describe('ProviderConfigSchema', () => {
  it('validates a minimal cloud provider', () => {
    const result = ProviderConfigSchema.parse({ type: 'cloud' });
    expect(result.type).toBe('cloud');
  });

  it('validates all valid provider types', () => {
    for (const type of ['cloud', 'ollama', 'lmstudio'] as const) {
      const result = ProviderConfigSchema.parse({ type });
      expect(result.type).toBe(type);
    }
  });

  it('validates provider with all optional fields', () => {
    const result = ProviderConfigSchema.parse({
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: 'sk-test',
      model: 'llama3',
    });

    expect(result.type).toBe('ollama');
    expect(result.baseUrl).toBe('http://localhost:11434');
    expect(result.apiKey).toBe('sk-test');
    expect(result.model).toBe('llama3');
  });

  it('rejects invalid provider type', () => {
    expect(() => ProviderConfigSchema.parse({ type: 'openai' })).toThrow();
    expect(() => ProviderConfigSchema.parse({ type: 'anthropic' })).toThrow();
    expect(() => ProviderConfigSchema.parse({ type: '' })).toThrow();
  });

  it('rejects missing type field', () => {
    expect(() => ProviderConfigSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ExecutionConfigSchema
// ---------------------------------------------------------------------------

describe('ExecutionConfigSchema', () => {
  it('validates an empty execution config (all optional)', () => {
    const result = ExecutionConfigSchema.parse({});
    expect(result).toEqual({});
  });

  it('validates execution config with all fields', () => {
    const result = ExecutionConfigSchema.parse({
      model: 'claude-opus-4-20250514',
      maxTurns: 20,
      timeoutSeconds: 600,
      provider: { type: 'cloud' },
    });

    expect(result.model).toBe('claude-opus-4-20250514');
    expect(result.maxTurns).toBe(20);
    expect(result.timeoutSeconds).toBe(600);
    expect(result.provider?.type).toBe('cloud');
  });

  it('validates execution config with only model', () => {
    const result = ExecutionConfigSchema.parse({ model: 'claude-haiku-4-5' });
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.maxTurns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ContextQuerySchema
// ---------------------------------------------------------------------------

describe('ContextQuerySchema', () => {
  it('validates a complete context query', () => {
    const result = ContextQuerySchema.parse({
      tool: 'vault_search',
      queryTemplate: 'unprocessed batches',
      limit: 10,
      purpose: 'Find recent unprocessed content',
      required: true,
    });

    expect(result.tool).toBe('vault_search');
    expect(result.queryTemplate).toBe('unprocessed batches');
    expect(result.limit).toBe(10);
    expect(result.purpose).toBe('Find recent unprocessed content');
    expect(result.required).toBe(true);
  });

  it('rejects context query missing required fields', () => {
    expect(() => ContextQuerySchema.parse({
      tool: 'vault_search',
      // missing queryTemplate, limit, purpose, required
    })).toThrow();
  });

  it('rejects context query with wrong types', () => {
    expect(() => ContextQuerySchema.parse({
      tool: 'vault_search',
      queryTemplate: 'q',
      limit: 'ten', // should be number
      purpose: 'test',
      required: true,
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PhaseDefinitionSchema
// ---------------------------------------------------------------------------

describe('PhaseDefinitionSchema', () => {
  it('validates a minimal phase (no model override)', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'extract',
      prompt: 'Extract spores from batches.',
      tools: ['vault_unprocessed', 'vault_create_spore'],
      maxTurns: 15,
      required: true,
    });

    expect(result.name).toBe('extract');
    expect(result.prompt).toBe('Extract spores from batches.');
    expect(result.tools).toEqual(['vault_unprocessed', 'vault_create_spore']);
    expect(result.maxTurns).toBe(15);
    expect(result.required).toBe(true);
    expect(result.model).toBeUndefined();
  });

  it('validates a phase with model override', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'digest',
      prompt: 'Build digest.',
      tools: ['vault_write_digest'],
      maxTurns: 5,
      model: 'claude-haiku-4-5',
      required: false,
    });

    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.required).toBe(false);
  });

  it('rejects phase missing required fields', () => {
    expect(() => PhaseDefinitionSchema.parse({
      name: 'extract',
      // missing prompt, tools, maxTurns, required
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentTaskSchema — minimal (no optional fields)
// ---------------------------------------------------------------------------

describe('AgentTaskSchema — minimal task', () => {
  it('validates a minimal task with only required fields', () => {
    const result = AgentTaskSchema.parse({
      name: 'test-task',
      displayName: 'Test Task',
      description: 'A simple test task.',
      agent: 'myco-agent',
      prompt: 'Do the thing.',
      isDefault: false,
    });

    expect(result.name).toBe('test-task');
    expect(result.displayName).toBe('Test Task');
    expect(result.description).toBe('A simple test task.');
    expect(result.agent).toBe('myco-agent');
    expect(result.prompt).toBe('Do the thing.');
    expect(result.isDefault).toBe(false);

    // All optional fields should be undefined
    expect(result.toolOverrides).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.maxTurns).toBeUndefined();
    expect(result.timeoutSeconds).toBeUndefined();
    expect(result.phases).toBeUndefined();
    expect(result.execution).toBeUndefined();
    expect(result.contextQueries).toBeUndefined();
    expect(result.schemaVersion).toBeUndefined();
  });

  it('rejects task missing required fields', () => {
    // Missing name
    expect(() => AgentTaskSchema.parse({
      displayName: 'Test',
      description: 'desc',
      agent: 'myco-agent',
      prompt: 'Do it.',
      isDefault: false,
    })).toThrow();

    // Missing prompt
    expect(() => AgentTaskSchema.parse({
      name: 'test',
      displayName: 'Test',
      description: 'desc',
      agent: 'myco-agent',
      isDefault: false,
    })).toThrow();

    // Missing agent
    expect(() => AgentTaskSchema.parse({
      name: 'test',
      displayName: 'Test',
      description: 'desc',
      prompt: 'Do it.',
      isDefault: false,
    })).toThrow();

    // Missing isDefault
    expect(() => AgentTaskSchema.parse({
      name: 'test',
      displayName: 'Test',
      description: 'desc',
      agent: 'myco-agent',
      prompt: 'Do it.',
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentTaskSchema — with phases array
// ---------------------------------------------------------------------------

describe('AgentTaskSchema — with phases', () => {
  it('validates a task with a phases array', () => {
    const result = AgentTaskSchema.parse({
      name: 'phased-task',
      displayName: 'Phased Task',
      description: 'A task with phases.',
      agent: 'myco-agent',
      prompt: 'Run the phased pipeline.',
      isDefault: false,
      phases: [
        {
          name: 'read-state',
          prompt: 'Read vault state.',
          tools: ['vault_state'],
          maxTurns: 3,
          required: true,
        },
        {
          name: 'extract',
          prompt: 'Extract spores.',
          tools: ['vault_unprocessed', 'vault_create_spore'],
          maxTurns: 15,
          required: true,
        },
      ],
    });

    expect(result.phases).toBeDefined();
    expect(result.phases!.length).toBe(2);
    expect(result.phases![0].name).toBe('read-state');
    expect(result.phases![1].name).toBe('extract');
  });

  it('validates a task with an empty phases array', () => {
    const result = AgentTaskSchema.parse({
      name: 'empty-phases',
      displayName: 'Empty Phases',
      description: 'Phases but empty.',
      agent: 'myco-agent',
      prompt: 'Nothing.',
      isDefault: false,
      phases: [],
    });

    expect(result.phases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AgentTaskSchema — with execution overrides
// ---------------------------------------------------------------------------

describe('AgentTaskSchema — with execution overrides', () => {
  it('validates a task with execution model override', () => {
    const result = AgentTaskSchema.parse({
      name: 'fast-task',
      displayName: 'Fast Task',
      description: 'Uses a cheaper model.',
      agent: 'myco-agent',
      prompt: 'Do something quickly.',
      isDefault: false,
      execution: {
        model: 'claude-haiku-4-5',
        maxTurns: 5,
      },
    });

    expect(result.execution).toBeDefined();
    expect(result.execution!.model).toBe('claude-haiku-4-5');
    expect(result.execution!.maxTurns).toBe(5);
  });

  it('validates a task with execution provider config', () => {
    const result = AgentTaskSchema.parse({
      name: 'local-task',
      displayName: 'Local Task',
      description: 'Uses local Ollama.',
      agent: 'myco-agent',
      prompt: 'Run locally.',
      isDefault: false,
      execution: {
        provider: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
          model: 'llama3',
        },
      },
    });

    expect(result.execution!.provider!.type).toBe('ollama');
    expect(result.execution!.provider!.baseUrl).toBe('http://localhost:11434');
    expect(result.execution!.provider!.model).toBe('llama3');
  });

  it('rejects task with invalid provider type in execution', () => {
    expect(() => AgentTaskSchema.parse({
      name: 'bad-task',
      displayName: 'Bad Task',
      description: 'Invalid provider.',
      agent: 'myco-agent',
      prompt: 'Run.',
      isDefault: false,
      execution: {
        provider: { type: 'openai' }, // not a valid enum value
      },
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentTaskSchema — with contextQueries
// ---------------------------------------------------------------------------

describe('AgentTaskSchema — with contextQueries', () => {
  it('validates a task with contextQueries', () => {
    const result = AgentTaskSchema.parse({
      name: 'context-task',
      displayName: 'Context Task',
      description: 'Pre-loads vault context.',
      agent: 'myco-agent',
      prompt: 'Use context to work.',
      isDefault: false,
      contextQueries: {
        initial: [
          {
            tool: 'vault_search',
            queryTemplate: 'recent spores',
            limit: 20,
            purpose: 'Load recent observations',
            required: false,
          },
        ],
        'pre-digest': [
          {
            tool: 'vault_unprocessed',
            queryTemplate: '',
            limit: 50,
            purpose: 'Check unprocessed queue',
            required: true,
          },
        ],
      },
    });

    expect(result.contextQueries).toBeDefined();
    expect(result.contextQueries!['initial']).toHaveLength(1);
    expect(result.contextQueries!['initial'][0].tool).toBe('vault_search');
    expect(result.contextQueries!['pre-digest']).toHaveLength(1);
    expect(result.contextQueries!['pre-digest'][0].required).toBe(true);
  });

  it('validates a task with empty contextQueries record', () => {
    const result = AgentTaskSchema.parse({
      name: 'no-queries',
      displayName: 'No Queries',
      description: 'Empty context queries.',
      agent: 'myco-agent',
      prompt: 'Do nothing.',
      isDefault: false,
      contextQueries: {},
    });

    expect(result.contextQueries).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// AgentTaskSchema — with schemaVersion
// ---------------------------------------------------------------------------

describe('AgentTaskSchema — with schemaVersion', () => {
  it('validates a task with schemaVersion', () => {
    const result = AgentTaskSchema.parse({
      name: 'versioned-task',
      displayName: 'Versioned Task',
      description: 'Has a schema version.',
      agent: 'myco-agent',
      prompt: 'Run versioned.',
      isDefault: false,
      schemaVersion: 1,
    });

    expect(result.schemaVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AgentTaskSchema — backward compatibility (existing YAML shape)
// ---------------------------------------------------------------------------

describe('AgentTaskSchema — backward compatibility', () => {
  it('parses a task shaped like the existing digest-only YAML', () => {
    // This is representative of what existing YAML files produce
    const result = AgentTaskSchema.parse({
      name: 'digest-only',
      displayName: 'Digest Only',
      description: 'Regenerates digests from existing vault content.',
      agent: 'myco-agent',
      prompt: 'Regenerate the vault digest extracts.',
      isDefault: false,
      toolOverrides: ['vault_write_digest', 'vault_state'],
    });

    expect(result.name).toBe('digest-only');
    expect(result.toolOverrides).toEqual(['vault_write_digest', 'vault_state']);
    expect(result.phases).toBeUndefined();
    expect(result.execution).toBeUndefined();
    expect(result.contextQueries).toBeUndefined();
  });

  it('parses a task shaped like the existing full-intelligence YAML', () => {
    const result = AgentTaskSchema.parse({
      name: 'full-intelligence',
      displayName: 'Full Intelligence',
      description: 'Complete intelligence pipeline.',
      agent: 'myco-agent',
      prompt: 'Run full intelligence pipeline.',
      isDefault: true,
    });

    expect(result.name).toBe('full-intelligence');
    expect(result.isDefault).toBe(true);
    expect(result.toolOverrides).toBeUndefined();
  });

  it('parses a task with optional model and maxTurns (existing pattern)', () => {
    const result = AgentTaskSchema.parse({
      name: 'extract-only',
      displayName: 'Extract Only',
      description: 'Extract spores only.',
      agent: 'myco-agent',
      prompt: 'Extract spores from unprocessed batches.',
      isDefault: false,
      model: 'claude-haiku-4-5',
      maxTurns: 20,
      timeoutSeconds: 180,
    });

    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.maxTurns).toBe(20);
    expect(result.timeoutSeconds).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// AgentDefinitionSchema — basic coverage
// ---------------------------------------------------------------------------

describe('AgentDefinitionSchema', () => {
  it('validates a complete agent definition', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'myco-agent',
      displayName: 'Myco Agent',
      description: 'The built-in agent.',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 30,
      timeoutSeconds: 300,
      systemPromptPath: '../prompts/agent.md',
      tools: ['vault_unprocessed', 'vault_create_spore'],
    });

    expect(result.name).toBe('myco-agent');
    expect(result.tools).toHaveLength(2);
  });

  it('rejects agent definition missing tools array', () => {
    expect(() => AgentDefinitionSchema.parse({
      name: 'myco-agent',
      displayName: 'Myco Agent',
      description: 'The built-in agent.',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 30,
      timeoutSeconds: 300,
      systemPromptPath: '../prompts/agent.md',
      // missing tools
    })).toThrow();
  });
});
