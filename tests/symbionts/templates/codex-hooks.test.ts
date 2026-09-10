import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadManifests } from '@myco/symbionts/detect.js';

const TEMPLATES_DIR = path.join(import.meta.dirname, '../../../packages/myco/src/symbionts/templates');

/**
 * Codex's hook template wires the retained set and nothing beyond it: the
 * Deployment parses the rollout, so the hooks register the session, ship the
 * delta and inject. The one addition is read off the manifest rather than
 * assumed: a transcript the parser cannot derive tool calls from
 * (`transcriptFidelity: no_tool_results`) keeps `PostToolUse`, and a `full`
 * one must not, since the parse already writes the row. A PreToolUse or
 * SubagentStop entry would spend a process per event for nothing either way.
 */
describe('codex hooks.json template', () => {
  const tplPath = path.join(TEMPLATES_DIR, 'codex', 'hooks.json');
  const tpl = JSON.parse(readFileSync(tplPath, 'utf8')) as Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>>;

  const manifest = loadManifests().find((m) => m.name === 'codex')!;
  const toolCallHooks = manifest.capabilities?.transcriptFidelity === 'no_tool_results' ? ['PostToolUse'] : [];

  it('registers exactly the retained lifecycle events, plus the tool-call hook where the manifest declares the parse cannot derive tool calls', () => {
    expect(Object.keys(tpl).sort()).toEqual(['SessionStart', 'Stop', 'SubagentStart', 'UserPromptSubmit', ...toolCallHooks].sort());
  });

  it('every entry invokes its own hook verb with the codex symbiont flag and a declared timeout', () => {
    const verbs: Record<string, string> = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt-submit', SubagentStart: 'subagent-start', Stop: 'stop', ...(toolCallHooks.length > 0 ? { PostToolUse: 'post-tool-use' } : {}) };
    for (const [event, verb] of Object.entries(verbs)) {
      const groups = tpl[event];
      expect(groups).toHaveLength(1);
      const handler = groups[0].hooks[0];
      expect(handler.type).toBe('command');
      expect(handler.command).toBe(`{{mycoLauncher}} hook ${verb} --symbiont codex`);
      expect(typeof handler.timeout).toBe('number');
    }
  });

  it('gives the turn-end hook the longest budget and the prompt hook a short one', () => {
    expect(tpl.Stop[0].hooks[0].timeout).toBe(30);
    expect(tpl.UserPromptSubmit[0].hooks[0].timeout).toBeLessThanOrEqual(5);
    expect(tpl.SubagentStart[0].hooks[0].timeout).toBeLessThanOrEqual(5);
  });
});
