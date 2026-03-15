import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmResponse, EmbeddingResponse, LlmRequestOptions } from './llm.js';

interface AnthropicConfig {
  model?: string;
  // Legacy fields
  summary_model?: string;
  embedding_provider?: string;
}

export class AnthropicBackend implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(config?: AnthropicConfig) {
    this.client = new Anthropic();
    this.model = config?.model ?? config?.summary_model ?? 'claude-haiku-4-5-20251001';
  }

  async summarize(prompt: string, opts?: LlmRequestOptions): Promise<LlmResponse> {
    const maxTokens = opts?.maxTokens ?? 1024;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return { text, model: this.model };
  }

  async embed(_text: string): Promise<EmbeddingResponse> {
    throw new Error(
      'AnthropicBackend does not support embeddings. Use a local provider (Ollama or LM Studio) for embeddings.'
    );
  }

  async isAvailable(): Promise<boolean> {
    try {
      return !!process.env.ANTHROPIC_API_KEY;
    } catch {
      return false;
    }
  }
}
