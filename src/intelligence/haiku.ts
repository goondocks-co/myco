import Anthropic from '@anthropic-ai/sdk';
import type { LlmBackend, LlmResponse, EmbeddingResponse } from './llm.js';

interface HaikuConfig {
  summary_model?: string;
  embedding_provider?: string;
}

export class HaikuBackend implements LlmBackend {
  readonly name = 'haiku';
  private client: Anthropic;
  private model: string;

  constructor(config?: HaikuConfig) {
    this.client = new Anthropic();
    this.model = config?.summary_model ?? 'claude-haiku-4-5-20251001';
  }

  async summarize(prompt: string): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
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
      'HaikuBackend does not support embeddings directly. Use the embeddings module with Voyage AI.'
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
