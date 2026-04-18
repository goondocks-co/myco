import fs from 'node:fs';
import path from 'node:path';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

const SESSION_START_SIGNALS = ['hook session-start', '"/context"', '"/context/resume"'] as const;
const PROMPT_SUBMIT_SIGNALS = ['hook user-prompt-submit', '"/context/prompt"'] as const;

export interface SymbiontInjectionSupport {
  supportsSessionStartInjection: boolean;
  supportsPromptSubmitInjection: boolean;
}

function resolveTemplateCandidates(manifest: SymbiontManifest): string[] {
  const packageRoot = resolvePackageRoot();
  const templateFile = manifest.registration?.hooksFormat === 'plugin-file' ? 'plugin.ts' : 'hooks.json';
  return [
    path.join(packageRoot, 'src', 'symbionts', 'templates', manifest.name, templateFile),
    path.join(packageRoot, 'dist', 'src', 'symbionts', 'templates', manifest.name, templateFile),
  ];
}

function readHooksTemplate(manifest: SymbiontManifest): string {
  for (const candidate of resolveTemplateCandidates(manifest)) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8');
    }
  }
  return '';
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
