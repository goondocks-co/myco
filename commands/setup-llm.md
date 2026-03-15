---
name: myco-setup-llm
description: Configure or change the intelligence backend (Ollama, LM Studio, or Claude Anthropic)
---

# LLM Backend Setup

Guide the user through configuring their intelligence backend:

1. **Detect available providers:**
   - Check if Ollama is running (`http://localhost:11434/api/tags`)
   - Check if LM Studio is running (`http://localhost:1234/v1/models`)
   - Check if `ANTHROPIC_API_KEY` is set (for Claude Anthropic)
2. **LLM provider:** Ask the user to select from available providers (Ollama, LM Studio, Anthropic)
   - For **Ollama:** list available models, recommend **`gpt-oss`**
   - For **LM Studio:** list available models and let user choose
   - For **Anthropic:** verify API key works with a test call
   - Set `context_window` (default 8192) and `max_tokens` (default 1024)
3. **Embedding provider:** Ask the user to select from available providers — **excluding Anthropic** (Ollama and LM Studio only, Anthropic does not support embeddings)
   - For **Ollama:** list available models, recommend **`bge-m3`** or `nomic-embed-text`
   - For **LM Studio:** list available models and let user choose
4. **Update `myco.yaml`** with both `intelligence.llm` and `intelligence.embedding` sections, all defaults explicit:
   ```yaml
   intelligence:
     llm:
       provider: ollama
       model: gpt-oss
       base_url: http://localhost:11434
       context_window: 8192
       max_tokens: 1024
     embedding:
       provider: ollama
       model: bge-m3
       base_url: http://localhost:11434
   ```
   Bump `version` to `2` if migrating from a v1 config.
5. **Process any pending buffers** that failed due to previous backend issues
