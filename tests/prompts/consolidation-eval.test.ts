import { describe, it } from 'vitest';
import { loadPrompt } from '@myco/prompts/index';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This test requires a running LLM. Run manually:
// EVAL_LLM=true npx vitest run tests/prompts/consolidation-eval.test.ts

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

describe.skipIf(SKIP)('Consolidation prompt evaluation', () => {
  it('should-consolidate fixture', async () => {
    const fixture = loadFixture('should-consolidate');
    const prompt = buildPrompt(fixture);
    console.log('Prompt length:', prompt.length, 'chars');
    console.log('Expected: consolidate = true, source_ids =', fixture.expected.expected_source_ids);
  });

  it('should-reject fixture', async () => {
    const fixture = loadFixture('should-reject');
    const prompt = buildPrompt(fixture);
    console.log('Prompt length:', prompt.length, 'chars');
    console.log('Expected: consolidate = false');
  });

  it('partial-consolidate fixture', async () => {
    const fixture = loadFixture('partial-consolidate');
    const prompt = buildPrompt(fixture);
    console.log('Prompt length:', prompt.length, 'chars');
    console.log('Expected: consolidate = true, subset =', fixture.expected.expected_source_ids_subset);
  });
});
