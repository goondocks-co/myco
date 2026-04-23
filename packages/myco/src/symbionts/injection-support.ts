import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

const SESSION_START_SIGNALS = ['hook session-start', '"/context"', '"/context/resume"'] as const;
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
  const template = readHooksTemplate(manifest);
  return {
    supportsSessionStartInjection: hasAnySignal(template, SESSION_START_SIGNALS),
    supportsPromptSubmitInjection: hasAnySignal(template, PROMPT_SUBMIT_SIGNALS),
  };
}
