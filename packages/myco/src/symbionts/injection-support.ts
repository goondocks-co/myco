import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

/**
 * How a template registers a session, in either of the two shapes a symbiont
 * uses: a hook command written into a config file, or a native plugin naming
 * the verb it runs through the binary.
 */
export const SESSION_START_SIGNALS = ['hook session-start', '"session-start"'] as const;
const PROMPT_SUBMIT_SIGNALS = ['hook user-prompt-submit', '"user-prompt-submit"'] as const;

export interface SymbiontInjectionSupport {
  supportsSessionStartInjection: boolean;
  supportsPromptSubmitInjection: boolean;
}

function resolveTemplateKey(manifest: SymbiontManifest): string {
  const reg = manifest.registration;
  const templateFile = reg?.hooksFormat === 'plugin-file'
    ? (reg.hooksTemplateFile ?? 'plugin.ts')
    : 'hooks.json';
  return `${manifest.name}/${templateFile}`;
}

function readHooksTemplate(manifest: SymbiontManifest): string {
  return BUNDLED_TEMPLATES[resolveTemplateKey(manifest)] ?? '';
}

function hasAnySignal(template: string, signals: readonly string[]): boolean {
  return signals.some((signal) => template.includes(signal));
}

export function detectSymbiontInjectionSupport(manifest: SymbiontManifest): SymbiontInjectionSupport {
  return {
    // sessionStartInjection is now a declared manifest capability. The
    // template scan via SESSION_START_SIGNALS is retained only for the
    // drift check in tests/symbionts/injection-support.test.ts.
    supportsSessionStartInjection: manifest.capabilities?.sessionStartInjection ?? false,
    supportsPromptSubmitInjection: hasAnySignal(readHooksTemplate(manifest), PROMPT_SUBMIT_SIGNALS),
  };
}
