import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readAntigravityPromptsFromTranscript } from '@myco/hooks/session-start.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function writeTranscript(filePath: string, rows: object[]): void {
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('readAntigravityPromptsFromTranscript', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-transcript-test-'));
    transcriptPath = path.join(tmpDir, 'transcript_full.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns prompts in order from USER_INPUT rows', () => {
    writeTranscript(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>first turn</USER_REQUEST>', created_at: 't1' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'thinking...', created_at: 't2' },
      { step_index: 2, type: 'USER_INPUT', content: '<USER_REQUEST>second turn</USER_REQUEST>', created_at: 't3' },
    ]);
    const prompts = readAntigravityPromptsFromTranscript(transcriptPath);
    expect(prompts).toEqual(['first turn', 'second turn']);
  });

  it('returns empty array when the transcript file is missing', () => {
    const prompts = readAntigravityPromptsFromTranscript(path.join(tmpDir, 'does-not-exist.jsonl'));
    expect(prompts).toEqual([]);
  });

  it('returns empty array on a transcript with no USER_INPUT rows', () => {
    writeTranscript(transcriptPath, [
      { step_index: 0, type: 'PLANNER_RESPONSE', content: 'just thinking', created_at: 't1' },
    ]);
    expect(readAntigravityPromptsFromTranscript(transcriptPath)).toEqual([]);
  });

  it('strips <ADDITIONAL_METADATA> / <USER_SETTINGS_CHANGE> envelopes', () => {
    writeTranscript(transcriptPath, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>hello</USER_REQUEST><ADDITIONAL_METADATA>cwd:/tmp</ADDITIONAL_METADATA>',
        created_at: 't1',
      },
    ]);
    expect(readAntigravityPromptsFromTranscript(transcriptPath)).toEqual(['hello']);
  });

  it('dedups byte-identical USER_INPUT re-emissions within one logical turn', () => {
    writeTranscript(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>only prompt</USER_REQUEST>', created_at: 't1' },
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>only prompt</USER_REQUEST>', created_at: 't2' },
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>only prompt</USER_REQUEST>', created_at: 't3' },
    ]);
    expect(readAntigravityPromptsFromTranscript(transcriptPath)).toEqual(['only prompt']);
  });
});
