/**
 * Manifest-coverage + anti-drift tests for `detectSymbiontInjectionSupport`.
 *
 * The detector reads each symbiont's hook template text and infers whether
 * the template registers a session-start or user-prompt-submit hook. The
 * expected-support map below pins the current truth for all built-in
 * symbionts. When a template gains or loses a hook registration, the
 * detector's output must flip; the anti-drift test below catches cases
 * where the detector stops recognizing an existing registration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { loadManifests } from '@myco/symbionts/detect.js';
import { detectSymbiontInjectionSupport, SESSION_START_SIGNALS } from '@myco/symbionts/injection-support.js';

/**
 * Expected support map per symbiont, keyed by manifest.name. When a new
 * symbiont is added to `packages/myco/src/symbionts/manifests/`, append
 * an entry here — the first test below fails until this map is updated,
 * which forces the author to think about session-start support.
 */
const EXPECTED_SUPPORT: Record<string, { session: boolean; prompt: boolean }> = {
  'claude-code': { session: true, prompt: true },
  codex: { session: true, prompt: true },
  cursor: { session: true, prompt: true },
  // Antigravity exposes PreInvocation (per model call, not per user prompt)
  // and Stop. There is no user-prompt-submit equivalent in the live hooks
  // contract at https://antigravity.google/docs/hooks — `prompt: false`.
  antigravity: { session: true, prompt: false },
  // opencode + pi deliver per-prompt context via their plugin templates'
  // POST /context/prompt call (opencode: chat.message output.parts push;
  // pi: before_agent_start custom message), detected via PROMPT_SUBMIT_SIGNALS.
  opencode: { session: true, prompt: true },
  pi: { session: true, prompt: true },
  copilot: { session: true, prompt: true },
  windsurf: { session: false, prompt: true },
};

const EXPECTED_SUBAGENT_START_INJECTION: Record<string, boolean> = {
  'claude-code': true,
  codex: true,
  cursor: false,
  antigravity: false,
  opencode: false,
  pi: false,
  copilot: true,
  windsurf: false,
};

describe('detectSymbiontInjectionSupport', () => {
  const manifests = loadManifests();

  it('enumerates at least one manifest', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it('matches the expected injection-support flags for every built-in symbiont', () => {
    // Use only the flags we actually pin; if a symbiont has been added to
    // the manifests directory but not the pin map, surface that via a
    // separate expect so the failure message is informative.
    const actual: Record<string, { session: boolean; prompt: boolean }> = {};
    for (const manifest of manifests) {
      const support = detectSymbiontInjectionSupport(manifest);
      actual[manifest.name] = {
        session: support.supportsSessionStartInjection,
        prompt: support.supportsPromptSubmitInjection,
      };
    }
    expect(actual).toEqual(EXPECTED_SUPPORT);
  });

  // Anti-drift: when a hook template contains `hook session-start` (the
  // canonical Claude Code hook directive), the detector MUST report
  // `supportsSessionStartInjection: true`. If the detector's signal list
  // drifts away from the template vocabulary, this test fails.
  it('never lies: templates with `hook session-start` always report supportsSessionStartInjection=true', () => {
    for (const manifest of manifests) {
      const templateFile = manifest.registration?.hooksFormat === 'plugin-file'
        ? (manifest.registration.hooksTemplateFile ?? 'plugin.ts')
        : 'hooks.json';
      const templatePath = path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'packages/myco/src/symbionts/templates',
        manifest.name,
        templateFile,
      );
      if (!fs.existsSync(templatePath)) continue;
      const template = fs.readFileSync(templatePath, 'utf-8');
      if (!template.includes('hook session-start')) continue;
      const support = detectSymbiontInjectionSupport(manifest);
      expect(
        support.supportsSessionStartInjection,
        `${manifest.name} template has "hook session-start" but detector reports false`,
      ).toBe(true);
    }
  });

  // Drift check: now that sessionStartInjection is a declared manifest
  // capability, ensure each manifest's declared value matches what the
  // legacy template scan would conclude. If a hooks template gains or
  // loses a session-start registration without a corresponding manifest
  // edit (or vice versa), this test fails and points at the offender.
  it('manifest sessionStartInjection matches the template scan for every symbiont', () => {
    for (const manifest of manifests) {
      const templateFile = manifest.registration?.hooksFormat === 'plugin-file'
        ? (manifest.registration.hooksTemplateFile ?? 'plugin.ts')
        : 'hooks.json';
      const templatePath = path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'packages/myco/src/symbionts/templates',
        manifest.name,
        templateFile,
      );
      if (!fs.existsSync(templatePath)) continue;
      const template = fs.readFileSync(templatePath, 'utf-8');
      const templateHasSignal = SESSION_START_SIGNALS.some((signal) => template.includes(signal));
      const declared = manifest.capabilities?.sessionStartInjection ?? false;
      expect(
        declared,
        `${manifest.name}: manifest declares sessionStartInjection=${declared} but template scan = ${templateHasSignal}`,
      ).toBe(templateHasSignal);
    }
  });

  it('pins the docs-grounded subagent-start injection capability matrix', () => {
    const actual: Record<string, boolean> = {};
    for (const manifest of manifests) {
      actual[manifest.name] = manifest.capabilities?.subagentStartInjection ?? false;
    }
    expect(actual).toEqual(EXPECTED_SUBAGENT_START_INJECTION);
  });

  it('requires every true subagent-start injection capability to have a hook template entry', () => {
    for (const manifest of manifests) {
      if (!manifest.capabilities?.subagentStartInjection) continue;
      const templateFile = manifest.registration?.hooksFormat === 'plugin-file'
        ? (manifest.registration.hooksTemplateFile ?? 'plugin.ts')
        : 'hooks.json';
      const templatePath = path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'packages/myco/src/symbionts/templates',
        manifest.name,
        templateFile,
      );
      expect(fs.existsSync(templatePath), `${manifest.name}: missing hooks template`).toBe(true);
      const template = fs.readFileSync(templatePath, 'utf-8');
      expect(
        template.includes('hook subagent-start'),
        `${manifest.name}: subagentStartInjection=true but template does not invoke hook subagent-start`,
      ).toBe(true);
    }
  });
});
