import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

export const SESSION_START_SIGNALS = ['hook session-start', '"/context"', '"/context/resume"'] as const;
const PROMPT_SUBMIT_SIGNALS = ['hook user-prompt-submit', '"/context/prompt"'] as const;

export interface SymbiontInjectionSupport {
  supportsSessionStartInjection: boolean;
  supportsPromptSubmitInjection: boolean;
}

function resolveTemplateKey(manifest: SymbiontManifest): string {
  const templateFile = manifest.registration?.hooksFormat === 'plugin-file' ? 'plugin.ts' : 'hooks.json';
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
