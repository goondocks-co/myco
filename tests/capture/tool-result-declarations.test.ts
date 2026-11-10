/**
 * Each harness's tool-result failure flag is declared once, in its manifest,
 * and carried unchanged into both generated carriers. A declared flag is read
 * through the shared accessor and the harness's parser: a reported failure
 * becomes a tool.failure, and a success or an absent flag a tool.use.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { assertToolResultDeclaration, toolResultDeclarationOf, toolResultFailed, ToolResultDeclarationInvalid } from '@goondocks/myco-shared/tool-result';
import { getAtPath, unsetAtPath } from '@goondocks/myco-shared/dot-path';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { DECLARED_SCHEMES } from '@myco-server-worker/ingest/prompt-scheme.js';
import evidence from '../fixtures/tool-result-evidence.json';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const MANIFEST_DIR = path.join(ROOT, 'packages/myco/src/symbionts/manifests');
const manifests = fs.readdirSync(MANIFEST_DIR).filter(file => file.endsWith('.yaml'))
  .map(file => SymbiontManifestSchema.parse(YAML.parse(fs.readFileSync(path.join(MANIFEST_DIR, file), 'utf8'))));

describe('tool result declarations', () => {
  it('declares the failure flag and its evidence for every agent whose manifest reads one', () => {
    const agents = manifests.filter(manifest => manifest.toolResult).map(manifest => manifest.name).sort();
    expect(agents.length).toBeGreaterThan(0);
    expect(evidence.map(row => row.agent).sort()).toEqual(agents);
    for (const agent of agents) expect(toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, agent)).toBeDefined();
  });

  it('carries the exact manifest declaration through both generated carriers', () => {
    for (const manifest of manifests) {
      expect(toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, manifest.name)).toEqual(manifest.toolResult);
      expect(BUNDLED_MANIFESTS.find(bundle => bundle.name === manifest.name)?.toolResult).toEqual(manifest.toolResult);
    }
  });

  it('pairs every declared flag with reported, success and absent evidence through the accessor and parser', async () => {
    for (const row of evidence) {
      const declaration = toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, row.agent)!;
      assertToolResultDeclaration(row.agent, declaration);
      expect(fs.existsSync(path.join(ROOT, declaration.evidence))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(ROOT, declaration.evidence), 'utf8'))).toEqual(evidence);
      expect(fs.existsSync(path.join(ROOT, row.provenance.source))).toBe(true);
      expect(row.provenance.detail.length).toBeGreaterThan(0);
      if (declaration.failure === null) {
        expect(row.reported).toBeUndefined();
        const records = fs.readFileSync(path.join(ROOT, row.provenance.source), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const outputs = records.filter(record => record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(record.payload?.type));
        expect(outputs.length).toBeGreaterThan(0);
        for (const record of outputs) {
          expect(record.payload).not.toHaveProperty('success');
          expect(toolResultFailed({ declaration, record, result: record.payload })).toBe(false);
        }
        expect(toolResultFailed({ declaration, record: { payload: { success: false } } })).toBe(false);
        for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
          const events = await PARSERS[row.agent]!.parse({ lines: records.map((value, offset) => ({ value, offset })),
            sessionId: 'result-session', transcriptId: 'result-transcript', recordScheme,
            scheme: DECLARED_SCHEMES[row.agent]!, now: Date.parse('2027-01-01T00:00:00Z'), terminal: 'complete_file' });
          const tools = events.filter(event => event.kind === 'tool.use' || event.kind === 'tool.failure');
          expect(tools.length).toBeGreaterThan(0);
          for (const tool of tools) expect({ kind: tool.kind, reason: tool.payload.resultReason, success: tool.payload.success })
            .toEqual({ kind: 'tool.use', reason: undefined, success: true });
        }
        continue;
      }
      const failure = declaration.failure;
      const paired = [row.reported, row.success].map(value => {
        const record = structuredClone(value);
        const result = 'resultPath' in row ? getAtPath(record, row.resultPath!) : undefined;
        unsetAtPath((failure.from === 'record' ? record : result) as Record<string, unknown>, failure.path);
        return record;
      });
      expect(paired[0]).toEqual(paired[1]);
      for (const outcome of ['reported', 'success', 'absent'] as const) {
        const record = structuredClone(outcome === 'reported' ? row.reported : row.success);
        const result = 'resultPath' in row ? getAtPath(record, row.resultPath!) : undefined;
        if (outcome === 'absent') unsetAtPath((failure.from === 'record' ? record : result) as Record<string, unknown>, failure.path);
        const failed = outcome === 'reported';
        expect({ agent: row.agent, outcome, failed: toolResultFailed({ declaration, record, result }) }).toEqual({ agent: row.agent, outcome, failed });
        for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
          const records = [...row.before, record];
          const lines = records.map((value, offset) => ({ value: value as Record<string, unknown>, offset }));
          const events = await PARSERS[row.agent]!.parse({ lines, sessionId: 'result-session', transcriptId: 'result-transcript', recordScheme,
            scheme: DECLARED_SCHEMES[row.agent]!, now: Date.parse('2027-01-01T00:00:00Z'), terminal: 'complete_file' });
          const tools = events.filter(event => event.kind === 'tool.use' || event.kind === 'tool.failure');
          expect({ agent: row.agent, outcome, recordScheme, kinds: tools.map(event => event.kind) }).toEqual({ agent: row.agent, outcome, recordScheme, kinds: [failed ? 'tool.failure' : 'tool.use'] });
          expect(tools[0]!.payload.resultReason).toBe(failed ? 'reported' : undefined);
          expect(tools[0]!.payload.success).toBe(!failed);
        }
      }
    }
  });

  it('refuses missing and malformed declarations in both schema and runtime accessor', () => {
    const original = toolResultDeclarationOf(CAPTURE_RULE_BUNDLES, 'claude-code')!;
    const mutations: Array<(value: any) => void> = [
      value => { delete value.evidence; }, value => { value.evidence = ''; }, value => { value.evidence = ' '; },
      value => { delete value.failure; }, value => { value.failure.from = 'call'; },
      value => { value.failure.path = ''; }, value => { value.failure.path = '...'; }, value => { value.failure.path = '__proto__.is_error'; },
      value => { value.failure.equals = 'true'; }, value => { delete value.failure.equals; },
      value => { value.failure.other = true; }, value => { value.other = true; },
    ];
    expect(() => toolResultFailed({ declaration: undefined })).toThrow(ToolResultDeclarationInvalid);
    for (const mutate of mutations) {
      const declaration = structuredClone(original); mutate(declaration);
      expect(() => assertToolResultDeclaration('claude-code', declaration)).toThrow(ToolResultDeclarationInvalid);
      expect(() => toolResultFailed({ declaration })).toThrow(ToolResultDeclarationInvalid);
      const manifest = { ...manifests.find(manifest => manifest.name === 'claude-code')!, toolResult: declaration };
      expect(SymbiontManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});
