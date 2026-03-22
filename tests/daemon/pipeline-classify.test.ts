import { describe, it, expect } from 'vitest';
import { classifyError } from '@myco/daemon/pipeline-classify';

describe('classifyError', () => {
  describe('config errors', () => {
    it('classifies model not found as config', () => {
      const err = new Error('LM Studio summarize failed: 404 {"error":{"message":"model not found"}}');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies resource exhaustion as config', () => {
      const err = new Error('model load failed: 500 {"error":{"type":"model_load_failed","message":"insufficient system resources"}}');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies ECONNREFUSED as config', () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' });
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies 401 as config', () => {
      const err = new Error('Anthropic summarize failed: 401 unauthorized');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies 403 as config', () => {
      const err = new Error('API call failed: 403 forbidden');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies ENOTFOUND for configured host as config', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND my-custom-host'), { code: 'ENOTFOUND' });
      expect(classifyError(err, { configuredHost: 'my-custom-host' }).type).toBe('config');
    });
  });

  describe('transient errors', () => {
    it('classifies timeout as transient', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies ETIMEDOUT as transient', () => {
      const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies 429 as transient', () => {
      const err = new Error('API call failed: 429 rate limited');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies 503 as transient', () => {
      const err = new Error('API call failed: 503 service unavailable');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies ECONNRESET as transient', () => {
      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies generic 500 as transient', () => {
      const err = new Error('API call failed: 500 internal server error');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies ENOTFOUND for well-known host as transient', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
      expect(classifyError(err).type).toBe('transient');
    });
  });

  describe('parse errors', () => {
    it('classifies JSON parse failure as parse', () => {
      const err = new SyntaxError('Unexpected token < in JSON at position 0');
      expect(classifyError(err).type).toBe('parse');
    });

    it('classifies empty response as parse', () => {
      const err = new Error('LLM returned empty content');
      err.name = 'ParseError';
      expect(classifyError(err).type).toBe('parse');
    });

    it('classifies reasoning-only response as parse', () => {
      const err = new Error('LLM returned only reasoning tokens, no usable output');
      expect(classifyError(err).type).toBe('parse');
      expect(classifyError(err).suggestedAction).toContain('reasoning');
    });

    it('classifies empty-after-strip response as parse', () => {
      const err = new Error('Response empty after stripping think tags');
      expect(classifyError(err).type).toBe('parse');
    });

    it('classifies observation extraction failed as parse', () => {
      const err = new Error('Observation extraction failed for session abc123');
      expect(classifyError(err).type).toBe('parse');
    });

    it('classifies missing output field as parse', () => {
      const err = new Error('LM Studio: missing output in response body');
      expect(classifyError(err).type).toBe('parse');
      expect(classifyError(err).suggestedAction).toContain('missing expected fields');
    });

    it('classifies no content in response as parse', () => {
      const err = new Error('Ollama: no content in response');
      expect(classifyError(err).type).toBe('parse');
    });

    it('classifies summarization failed as parse', () => {
      const err = new Error('Summarization failed for session abc123: timeout');
      expect(classifyError(err).type).toBe('parse');
    });
  });

  describe('defaults', () => {
    it('defaults unknown errors to transient', () => {
      const err = new Error('something unexpected happened');
      expect(classifyError(err).type).toBe('transient');
    });
  });

  describe('suggested actions', () => {
    it('provides suggested action for config errors', () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' });
      const result = classifyError(err, { providerName: 'LM Studio', baseUrl: 'http://localhost:1234' });
      expect(result.type).toBe('config');
      expect(result.suggestedAction).toBeDefined();
      expect(result.suggestedAction).toContain('LM Studio');
    });

    it('provides suggested action for model not loaded', () => {
      const err = new Error('LM Studio summarize failed: 404 model not found');
      const result = classifyError(err, { modelName: 'glm-4.7-flash' });
      expect(result.suggestedAction).toContain('glm-4.7-flash');
    });

    it('does not provide suggested action for transient errors', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      const result = classifyError(err);
      expect(result.suggestedAction).toBeUndefined();
    });
  });
});
