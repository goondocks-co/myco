import { describe, it, expect } from 'vitest';
import { loadPrompt } from '@myco/prompts/index';
import { createLlmProvider } from '@myco/intelligence/llm';
import { stripReasoningTokens } from '@myco/intelligence/response';
import { CONSOLIDATION_MAX_TOKENS, LLM_REASONING_MODE } from '@myco/constants';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Consolidation prompt evaluation suite.
 *
 * Requires a running LLM (Ollama). Run manually:
 *   EVAL_LLM=true npx vitest run tests/prompts/consolidation-eval.test.ts
 *
 * Uses the vault's configured LLM provider (Ollama qwen3.5 by default).
 */

const SKIP = !process.env.EVAL_LLM;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  description: string;
  observation_type: string;
  candidates: Array<{ id: string; content: string }>;
  expected: {
    consolidate: boolean;
    expected_source_ids?: string[];
    expected_source_ids_subset?: string[];
    expected_excluded?: string[];
  };
}

interface ConsolidateResponse {
  consolidate: boolean;
  reason?: string;
  title?: string;
  content?: string;
  source_ids?: string[];
  tags?: string[];
}

function loadFixture(name: string): Fixture {
  const fixturePath = path.join(__dirname, 'consolidation-fixtures', `${name}.json`);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

function buildPrompt(fixture: Fixture): string {
  const template = loadPrompt('consolidation');
  const candidatesText = fixture.candidates
    .map((c) => `[${c.id}]\n${c.content}\n---`)
    .join('\n\n');

  return template
    .replace('{{count}}', String(fixture.candidates.length))
    .replace('{{observation_type}}', fixture.observation_type)
    .replace('{{candidates}}', candidatesText);
}

function createTestLlm() {
  return createLlmProvider({
    provider: 'ollama',
    model: process.env.EVAL_MODEL ?? 'qwen3.5:latest',
    base_url: process.env.EVAL_BASE_URL ?? 'http://localhost:11434',
  });
}

async function callLlm(prompt: string): Promise<ConsolidateResponse> {
  const llm = createTestLlm();
  const response = await llm.summarize(prompt, {
    maxTokens: CONSOLIDATION_MAX_TOKENS,
    reasoning: LLM_REASONING_MODE,
  });
  const text = stripReasoningTokens(response.text);

  // Extract JSON from response (LLM may wrap in markdown code fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in response:\n${text}`);
  }
  return JSON.parse(jsonMatch[0]);
}

describe.skipIf(SKIP)('Consolidation prompt evaluation', () => {
  it('should-consolidate: 3 SQLite WAL gotchas', async () => {
    const fixture = loadFixture('should-consolidate');
    const prompt = buildPrompt(fixture);
    console.log(`\n--- should-consolidate ---`);
    console.log(`Prompt: ${prompt.length} chars`);

    const result = await callLlm(prompt);
    console.log('Response:', JSON.stringify(result, null, 2));

    // Must decide to consolidate
    expect(result.consolidate).toBe(true);

    // Must include all 3 source IDs
    expect(result.source_ids).toBeDefined();
    for (const id of fixture.expected.expected_source_ids!) {
      expect(result.source_ids).toContain(id);
    }

    // Must not hallucinate IDs
    const validIds = new Set(fixture.candidates.map((c) => c.id));
    for (const id of result.source_ids!) {
      expect(validIds.has(id)).toBe(true);
    }

    // Content should preserve specifics
    expect(result.content).toBeDefined();
    expect(result.content!.length).toBeGreaterThan(50);
    // Check for specific details that should be preserved
    expect(result.content).toMatch(/WAL|wal/i);
  }, 60_000);

  it('should-reject: 3 unrelated decisions', async () => {
    const fixture = loadFixture('should-reject');
    const prompt = buildPrompt(fixture);
    console.log(`\n--- should-reject ---`);
    console.log(`Prompt: ${prompt.length} chars`);

    const result = await callLlm(prompt);
    console.log('Response:', JSON.stringify(result, null, 2));

    // Must decline consolidation
    expect(result.consolidate).toBe(false);
    expect(result.reason).toBeDefined();
    console.log('Decline reason:', result.reason);
  }, 60_000);

  it('partial-consolidate: 5 trade-offs, 3 CI/CD related', async () => {
    const fixture = loadFixture('partial-consolidate');
    const prompt = buildPrompt(fixture);
    console.log(`\n--- partial-consolidate ---`);
    console.log(`Prompt: ${prompt.length} chars`);

    const result = await callLlm(prompt);
    console.log('Response:', JSON.stringify(result, null, 2));

    // Should consolidate (at least the CI/CD subset)
    expect(result.consolidate).toBe(true);
    expect(result.source_ids).toBeDefined();

    // Should include the CI/CD trade-offs
    const included = new Set(result.source_ids!);
    const expectedSubset = fixture.expected.expected_source_ids_subset!;
    const includedFromSubset = expectedSubset.filter((id) => included.has(id));
    console.log(`Included from expected subset: ${includedFromSubset.length}/${expectedSubset.length}`);

    // At minimum, should include most of the expected subset
    expect(includedFromSubset.length).toBeGreaterThanOrEqual(2);

    // Should NOT include the auth trade-off (unrelated)
    const excluded = fixture.expected.expected_excluded!;
    for (const id of excluded) {
      if (included.has(id)) {
        console.warn(`WARNING: included excluded ID ${id}`);
      }
    }

    // Must not hallucinate IDs
    const validIds = new Set(fixture.candidates.map((c) => c.id));
    for (const id of result.source_ids!) {
      expect(validIds.has(id)).toBe(true);
    }
  }, 60_000);
});
