import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { settingsWriter, DEPLOYMENT_LEAF_SPECS } from '@myco-server-worker/core/settings.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';

const rig = () => {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  return settingsWriter(sqliteRelationalStore(sqlite));
};

describe('execution profile settings', () => {
  it('admits typed model and effort leaves for each supported profile harness and tier', () => {
    for (const harness of ['claude-code', 'codex', 'opencode']) {
      for (const tier of ['low', 'default', 'high']) {
        expect(DEPLOYMENT_LEAF_SPECS[`agent.reasoning_map.${harness}.${tier}`]).toBeDefined();
        expect(DEPLOYMENT_LEAF_SPECS[`agent.effort_map.${harness}.${tier}`]).toBeDefined();
      }
    }
  });

  it('refuses invalid models and effort without changing siblings', async () => {
    const w = rig();
    const model = 'agent.reasoning_map.claude-code.low';
    const effort = 'agent.effort_map.claude-code.low';
    expect(await w.setLeaf(model, 'claude-haiku-4-5', 'mem_1', 1)).toEqual({ applied: true });
    expect(await w.setLeaf(effort, 'low', 'mem_1', 2)).toEqual({ applied: true });
    expect(await w.setLeaf(model, 'openai/gpt', 'mem_1', 3)).toMatchObject({ applied: false, refusal: { reason: 'invalid_value' } });
    expect(await w.setLeaf(effort, 'max', 'mem_1', 3)).toMatchObject({ applied: false, refusal: { reason: 'invalid_value' } });
    expect(await w.leaves()).toMatchObject({ [model]: { value: 'claude-haiku-4-5' }, [effort]: { value: 'low' } });
  });

  it('requires a task model pin to name its harness and preserves the prior document', async () => {
    const w = rig();
    const prior = { 'title-summary': { reasoningLevel: 'low', harness: 'claude-code', model: 'haiku' } };
    expect(await w.setLeaf('agent.tasks', prior, 'mem_1', 1)).toEqual({ applied: true });
    expect(await w.setLeaf('agent.tasks', { 'title-summary': { model: 'opus' } }, 'mem_1', 2))
      .toMatchObject({ applied: false, refusal: { reason: 'invalid_value' } });
    expect((await w.leaves())['agent.tasks']?.value).toEqual(prior);
  });

  it('resets a profile leaf through the same writer and restores its effective default', async () => {
    const w = rig();
    const leaf = 'agent.reasoning_map.claude-code.low';
    expect(await w.setLeaf(leaf, 'sonnet', 'mem_1', 1)).toEqual({ applied: true });
    expect(await w.resetLeaf(leaf, 'mem_1')).toEqual({ applied: true });
    expect((await w.leaves())[leaf]).toBeUndefined();
  });
});
