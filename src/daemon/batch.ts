export interface BatchEvent {
  type: string;
  session_id: string;
  timestamp: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  output_preview?: string;
  [key: string]: unknown;
}

type BatchClosedCallback = (events: BatchEvent[]) => void | Promise<void>;

export class BatchManager {
  private batches: Map<string, BatchEvent[]> = new Map();
  private onBatchClosed: BatchClosedCallback;

  constructor(onBatchClosed: BatchClosedCallback) {
    this.onBatchClosed = onBatchClosed;
  }

  addEvent(event: BatchEvent): void {
    const sid = event.session_id;

    if (event.type === 'user_prompt') {
      const current = this.batches.get(sid);
      if (current && current.length > 0) {
        // Fire-and-forget, but log errors
        Promise.resolve(this.onBatchClosed(current)).catch((err) => {
          console.error(`[mycod] batch callback error: ${(err as Error).message}`);
        });
      }
      this.batches.set(sid, [event]);
    } else {
      const current = this.batches.get(sid);
      if (current) {
        current.push(event);
      }
    }
  }

  finalize(sessionId: string): BatchEvent[] {
    const current = this.batches.get(sessionId);
    this.batches.delete(sessionId);
    return current ?? [];
  }

  hasOpenBatch(sessionId: string): boolean {
    return this.batches.has(sessionId) && this.batches.get(sessionId)!.length > 0;
  }

  batchSize(sessionId: string): number {
    return this.batches.get(sessionId)?.length ?? 0;
  }
}
