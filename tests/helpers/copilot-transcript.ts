/**
 * Copyright 2026 Goondocks Co.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const COPILOT_SOURCED_USER_MESSAGE_PROMPT = 'Summarize the repo';
export const COPILOT_SOURCED_USER_MESSAGE_RESPONSE = 'This repository is a Myco development checkout.';

const COPILOT_TOOL_CONTEXT_SOURCE = 'skill-myco';
const COPILOT_TRANSCRIPT_EVENTS = {
  SESSION_START: 'session.start',
  USER_MESSAGE: 'user.message',
  ASSISTANT_MESSAGE: 'assistant.message',
  TOOL_EXECUTION_START: 'tool.execution_start',
} as const;

export function buildCopilotSourcedUserMessageTranscript(sessionId: string): string {
  return [
    JSON.stringify({
      type: COPILOT_TRANSCRIPT_EVENTS.SESSION_START,
      timestamp: '2026-06-11T21:00:00.000Z',
      data: { sessionId, version: 1, producer: 'copilot-agent' },
    }),
    JSON.stringify({
      type: COPILOT_TRANSCRIPT_EVENTS.USER_MESSAGE,
      timestamp: '2026-06-11T21:00:01.000Z',
      data: {
        content: COPILOT_SOURCED_USER_MESSAGE_PROMPT,
        transformedContent: COPILOT_SOURCED_USER_MESSAGE_PROMPT,
        attachments: [],
      },
    }),
    JSON.stringify({
      type: COPILOT_TRANSCRIPT_EVENTS.ASSISTANT_MESSAGE,
      timestamp: '2026-06-11T21:00:02.000Z',
      data: {
        content: '',
        reasoningText: 'I need to inspect the README first.',
        toolRequests: [{ id: 'tool-1' }],
      },
    }),
    JSON.stringify({
      type: COPILOT_TRANSCRIPT_EVENTS.TOOL_EXECUTION_START,
      timestamp: '2026-06-11T21:00:03.000Z',
      data: {
        toolCallId: 'tool-1',
        toolName: 'view',
        arguments: { path: 'README.md' },
      },
    }),
    JSON.stringify({
      type: COPILOT_TRANSCRIPT_EVENTS.USER_MESSAGE,
      timestamp: '2026-06-11T21:00:04.000Z',
      data: {
        source: COPILOT_TOOL_CONTEXT_SOURCE,
        content: 'tool result text',
      },
    }),
    JSON.stringify({
      type: COPILOT_TRANSCRIPT_EVENTS.ASSISTANT_MESSAGE,
      timestamp: '2026-06-11T21:00:05.000Z',
      data: {
        content: COPILOT_SOURCED_USER_MESSAGE_RESPONSE,
        toolRequests: [],
      },
    }),
  ].join('\n');
}
