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
  antigravity: { session: true, prompt: true },
  opencode: { session: true, prompt: false },
  pi: { session: true, prompt: false },
  copilot: { session: true, prompt: true },
  windsurf: { session: false, prompt: true },
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
});
