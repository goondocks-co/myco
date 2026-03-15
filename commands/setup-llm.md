---
name: myco-setup-llm
description: Configure or change the intelligence backend (Ollama, LM Studio, or Claude Haiku)
---

# LLM Backend Setup

Guide the user through configuring their intelligence backend:

1. **Detect available backends:**
   - Check if Ollama is running (`http://localhost:11434/api/tags`)
   - Check if LM Studio is running (`http://localhost:1234/v1/models`)
   - Check if ANTHROPIC_API_KEY is set
2. **Present options** based on what's available
3. **For Ollama:** Offer to pull required models (embedding + summary)
   - Recommended summary model: **`gpt-oss`**
   - Recommended embedding model: `nomic-embed-text`
4. **For LM Studio:** List available models and let user choose
5. **For Cloud:** Verify API key works with a test call
6. **Update `myco.yaml`** with new backend configuration
7. **Process any pending buffers** that failed due to previous backend issues
