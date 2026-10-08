/** An explicit reader preserves file-range bounds through Response consumption. */
export function fileBody(file: string, offset: number): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      if (reader === undefined) {
        const source = Bun.file(file);
        reader = (offset > 0 ? source.slice(offset) : source).stream().getReader();
      }
      const active = reader;
      let chunk: Awaited<ReturnType<typeof active.read>>;
      try { chunk = await active.read(); } catch (error) {
        active.releaseLock();
        reader = undefined;
        throw error;
      }
      if (cancelled) return;
      if (chunk.done) {
        active.releaseLock();
        reader = undefined;
        controller.close();
      } else controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      cancelled = true;
      const active = reader;
      reader = undefined;
      if (active !== undefined) {
        try { await active.cancel(reason); } finally { active.releaseLock(); }
      }
    },
  }, { highWaterMark: 0 });
}
