/** The name a person reads for a model provider, from the id an agent lists its models under. */
const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  'amazon-bedrock': 'Amazon Bedrock',
  anthropic: 'Anthropic',
  azure: 'Azure',
  deepseek: 'DeepSeek',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  'google-vertex': 'Google Vertex',
  groq: 'Groq',
  lmstudio: 'LM Studio',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  ollama: 'Ollama',
  'ollama-cloud': 'Ollama Cloud',
  openai: 'OpenAI',
  opencode: 'OpenCode Zen',
  openrouter: 'OpenRouter',
  xai: 'xAI',
};

/** A provider's name; one this table does not know reads as its id's words, each capitalized. */
export function providerLabel(id: string): string {
  return PROVIDER_LABEL[id] ?? id.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
