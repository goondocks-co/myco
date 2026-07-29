/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Environment variable for OpenAI API key stored in machine secrets. */
export const OPENAI_API_KEY_ENV = 'MYCO_OPENAI_API_KEY';

/** Environment variable for OpenRouter API key stored in machine secrets. */
export const OPENROUTER_API_KEY_ENV = 'MYCO_OPENROUTER_API_KEY';

/**
 * Environment variable for the Claude Code headless OAuth token (from
 * `claude setup-token`) stored in machine secrets. Unlike the MYCO_-prefixed
 * keys above, the name is Claude Code's own contract: the spawned CLI reads
 * exactly this variable, so Myco stores and injects it verbatim.
 */
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
