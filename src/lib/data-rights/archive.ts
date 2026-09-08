import { ZipWriter } from "@zip.js/zip.js";

/** Preserve numbers; protect text cells from spreadsheet formula execution. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const safe = typeof value === "number" ? text : /^[\s]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text;
  return /[",\r\n]/u.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}

export function csvLine(values: unknown[]): string { return values.map(csvCell).join(",") + "\r\n"; }

/** One generator step per pull. Cancellation closes database/file iterators. */
export function byteStream(iterator: AsyncGenerator<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { await iterator.return(undefined); controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
}

export async function* jsonLines(rows: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const row of rows) yield encoder.encode(JSON.stringify(row) + "\n");
}

export type ArchiveWriter = Pick<ZipWriter<unknown>, "add">;

/** Never buffer the complete archive. Add entries sequentially with backpressure.
 * A producer failure aborts the response, never a valid ZIP silently missing data.
 * Consumers must keep the HTTP request open; no work survives the request.
 */
export function streamedArchive(produce: (writer: ArchiveWriter, signal: AbortSignal) => Promise<void>, requestSignal?: AbortSignal) {
  const stop = new AbortController();
  const signal = requestSignal ? AbortSignal.any([stop.signal, requestSignal]) : stop.signal;
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = new ZipWriter(output.writable, { useWebWorkers: false, level: 0, bufferedWrite: false, zip64: true });
  const completed = (async () => {
    try { signal.throwIfAborted(); await produce(writer, signal); signal.throwIfAborted(); await writer.close(); }
    catch (error) {
      stop.abort(error);
      // zip.js releases its writer after each entry. Abort instead of closing a
      // central directory which could make a partial download appear complete.
      await output.writable.abort(error).catch(() => undefined);
      throw error;
    }
  })();
  // The caller can await completion for tests/cleanup without an unhandled rejection.
  void completed.catch(() => undefined);
  const reader = output.readable.getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const item = await reader.read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
      catch (error) { controller.error(error); }
    },
    async cancel(reason) { stop.abort(reason); await reader.cancel(reason); },
  });
  return { readable, completed };
}
