import { LmStudioBackend } from './lm-studio.js';
import { OllamaBackend } from './ollama.js';

export type LocalOpenAIBackendKind = 'ollama' | 'lmstudio';

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

const LOCAL_OPENAI_BACKEND_RULES: Array<{
  kind: LocalOpenAIBackendKind;
  matches: (input: {
    type?: string;
    localBackend?: LocalOpenAIBackendKind;
    baseUrl?: string;
  }) => boolean;
}> = [
  {
    kind: 'ollama',
    matches: ({ localBackend }) => localBackend === 'ollama',
  },
  {
    kind: 'lmstudio',
    matches: ({ localBackend }) => localBackend === 'lmstudio',
  },
  {
    kind: 'ollama',
    matches: ({ type }) => type === 'ollama',
  },
  {
    kind: 'lmstudio',
    matches: ({ type }) => type === 'lmstudio',
  },
  {
    kind: 'ollama',
    matches: ({ type, baseUrl }) => type === 'openai-compatible' && hasLocalPort(baseUrl, '11434'),
  },
  {
    kind: 'lmstudio',
    matches: ({ type, baseUrl }) => type === 'openai-compatible' && hasLocalPort(baseUrl, '1234'),
  },
];

type LocalBackendInstance = OllamaBackend | LmStudioBackend;

interface LocalBackendDefinition {
  defaultBaseUrl: string;
  label: string;
  create: (baseUrl?: string) => LocalBackendInstance;
}

const LOCAL_BACKEND_DEFINITIONS: Record<LocalOpenAIBackendKind, LocalBackendDefinition> = {
  ollama: {
    defaultBaseUrl: OllamaBackend.DEFAULT_BASE_URL,
    label: 'Ollama',
    create: (baseUrl) => new OllamaBackend({ base_url: baseUrl }),
  },
  lmstudio: {
    defaultBaseUrl: LmStudioBackend.DEFAULT_BASE_URL,
    label: 'LM Studio',
    create: (baseUrl) => new LmStudioBackend({ base_url: baseUrl }),
  },
};

export function tryParseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasLocalPort(baseUrl: string | undefined, port: string): boolean {
  const url = tryParseUrl(baseUrl);
  return !!url && LOCALHOST_NAMES.has(url.hostname) && url.port === port;
}

export function inferLocalOpenAIBackendKind(input: {
  type?: string;
  localBackend?: LocalOpenAIBackendKind;
  baseUrl?: string;
}): LocalOpenAIBackendKind | null {
  for (const rule of LOCAL_OPENAI_BACKEND_RULES) {
    if (rule.matches(input)) {
      return rule.kind;
    }
  }
  return null;
}

export function getLocalOpenAIBackendDefaultBaseUrl(kind: LocalOpenAIBackendKind): string {
  return LOCAL_BACKEND_DEFINITIONS[kind].defaultBaseUrl;
}

export function getLocalOpenAIBackendLabel(kind: LocalOpenAIBackendKind): string {
  return LOCAL_BACKEND_DEFINITIONS[kind].label;
}

export function createLocalOpenAIBackend(kind: LocalOpenAIBackendKind, baseUrl?: string): LocalBackendInstance {
  return LOCAL_BACKEND_DEFINITIONS[kind].create(baseUrl);
}
