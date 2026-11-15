import type { HookMainOptions } from '../member/capture.js';
import { renderToolRecall } from '../member/tool-recall.js';

export async function main(opts: HookMainOptions = {}): Promise<void> {
  await renderToolRecall(opts);
}
