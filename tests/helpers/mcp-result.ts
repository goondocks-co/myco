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

/**
 * The text of a tool result's first content block.
 *
 * The MCP client types a result's `content` open, so a caller reads a block
 * through here. A result with no text block throws naming what it carried,
 * rather than failing later on a parse of `undefined`.
 */
export function firstText(result: Record<string, unknown>): string {
  const blocks = result.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(`the tool result carried no content: ${JSON.stringify(result)}`);
  }
  const text = (blocks[0] as { text?: unknown }).text;
  if (typeof text !== 'string') {
    throw new Error(`the first content block carries no text: ${JSON.stringify(blocks[0])}`);
  }
  return text;
}

/** The first content block's text, parsed as JSON. */
export function firstJson<T = unknown>(result: Record<string, unknown>): T {
  return JSON.parse(firstText(result)) as T;
}
