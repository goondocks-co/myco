/**
 * The retained hook set, per harness, read off the manifests and templates
 * rather than a list kept by hand.
 *
 * A symbiont the Deployment parses (`turnRowSource: transcript`) wires hooks
 * for three jobs only — registering the session, shipping the transcript delta
 * and plan files at turn end, and injecting — plus the tool-call hooks where
 * its transcript carries no tool calls. Any other hook on such a template
 * spends a process per event to write a row the parse already writes, which is
 * the doubling #1155 removes. A symbiont whose hooks still write its turn rows
 * is not constrained here: it has no parse to duplicate.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifests } from '@myco/symbionts/detect.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { hookNameInCommand } from '@myco/member/constants.js';

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/myco/src/symbionts/templates');

/** The hooks a transcript-first symbiont may wire, and what each is for. */
const RETAINED: Readonly<Record<string, string>> = {
  'session-start': 'register the session, inject, carry the hook-exclusive session fields',
  'user-prompt-submit': 'inject; a plan pasted inside a tag envelope ships as a plan',
  'stop': 'ship the transcript delta and the plan files the turn wrote',
  'session-end': 'ship the final delta and end the session',
  'subagent-start': 'inject into the delegated agent',
};
/** The hooks a transcript-first symbiont wires only when its transcript carries no tool calls; the failure hook where the harness has the event. */
const TOOL_CALL_HOOKS: readonly string[] = ['post-tool-use', 'post-tool-use-failure'];
/** The hook each injection capability needs wired, or the declaration promises an injection nothing delivers. */
const INJECTION_HOOKS: Readonly<Record<string, string>> = {
  sessionStartInjection: 'session-start',
  subagentStartInjection: 'subagent-start',
  preToolUseInjection: 'pre-tool-use',
  postToolUseInjection: 'post-tool-use',
};

describe('the retained hook set', () => {
  const manifests = loadManifests().filter((m) => m.registration?.hooksTarget && (m.registration.hooksFormat ?? 'json') === 'json');

  it('covers the three tier-1 harnesses', () => {
    const transcriptFirst = manifests.filter((m) => m.capabilities?.turnRowSource === 'transcript').map((m) => m.name).sort();
    expect(transcriptFirst).toEqual(['claude-code', 'codex', 'cursor']);
  });

  for (const manifest of manifests) {
    const wired = [...new Set(hookCommands(JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, manifest.name, 'hooks.json'), 'utf-8'))).map((c) => hookNameInCommand(c)))].sort();
    it(`${manifest.name}: every injection capability it declares has its hook wired`, () => {
      for (const [capability, hook] of Object.entries(INJECTION_HOOKS)) {
        const declared = (manifest.capabilities as Record<string, unknown> | undefined)?.[capability] === true;
        if (declared) expect({ capability, wired: wired.includes(hook) }).toEqual({ capability, wired: true });
      }
    });
    if (manifest.capabilities?.turnRowSource !== 'transcript') {
      it(`${manifest.name}: its hooks write its turn rows, so the template is not held to the retained set`, () => {
        expect(wired.length).toBeGreaterThan(0);
      });
      continue;
    }
    const allowed = [...Object.keys(RETAINED), ...(manifest.capabilities.transcriptFidelity === 'no_tool_results' ? TOOL_CALL_HOOKS : [])];
    it(`${manifest.name}: wires only hooks from the retained set`, () => {
      for (const hook of wired) expect({ hook, retained: allowed.includes(hook as string) }).toEqual({ hook, retained: true });
    });
    it(`${manifest.name}: registers the session and ships the delta at turn end`, () => {
      expect(wired).toContain('session-start');
      expect(wired).toContain('stop');
    });
    if (manifest.capabilities.transcriptFidelity === 'no_tool_results') {
      it(`${manifest.name}: keeps the tool-call hook its transcript cannot replace`, () => {
        expect(wired).toContain('post-tool-use');
      });
    } else {
      it(`${manifest.name}: wires no tool-call hook, since its transcript carries the calls`, () => {
        for (const hook of TOOL_CALL_HOOKS) expect(wired).not.toContain(hook);
      });
    }
  }
});
