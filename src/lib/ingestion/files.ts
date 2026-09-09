import { BlobReader, ZipReader, configure } from "@zip.js/zip.js";
import { SaxesParser } from "saxes";
import { normaliseApple } from "./apple-normalise";
import { HealthCsvParser, normaliseCsv } from "./csv";
import { BATCH_SIZE, type DataSource, type DataSourceAdapter, type IngestionTransport, type NormalisedMetric, type SyncResult } from "./model";

export type ImportProgress = SyncResult & { records: number; unsupported: number; bytes: number; totalBytes: number; status: "working" | "done" | "cancelled" | "error";
  fileName?: string; fileIndex?: number; fileCount?: number; supportedFiles?: number; skippedFiles?: number };
type Options = { signal?: AbortSignal; onProgress?: (progress: ImportProgress) => void; timezone?: string; filePath?: string };
const MAX_PENDING_BATCHES = 3;
export class FileAdapter implements DataSourceAdapter {
  private state: ImportProgress = { inserted: 0, skipped: 0, errors: [], records: 0, unsupported: 0, bytes: 0, totalBytes: 0, status: "working" };
  constructor(readonly provider: "apple_health_export" | "generic_csv", private file: Blob, private transport: IngestionTransport, private options: Options = {}) {}
  connect(userId: string, input: unknown) {
    const key = typeof input === "string" && input.trim() ? input.trim() : this.provider === "generic_csv" ? "CSV" : "Apple Health";
    return this.transport.connect(userId, this.provider, key);
  }
  normalise(raw: unknown) { return this.provider === "apple_health_export" ? normaliseApple(raw) : normaliseCsv(raw); }
  async sync(source: DataSource): Promise<SyncResult> {
    this.state = { inserted: 0, skipped: 0, errors: [], records: 0, unsupported: 0, bytes: 0, totalBytes: 0, status: "working" };
    const { signal, onProgress } = this.options;
    const batch: NormalisedMetric[] = [];
    const acceptMetrics = (metrics: NormalisedMetric[]) => {
      this.state.records++;
      if (!metrics.length) this.state.unsupported++;
      batch.push(...metrics);
    };
    const accept = (raw: unknown) => acceptMetrics(this.normalise(raw));
    const pending = new Set<Promise<void>>();
    let persistenceError: unknown;
    const persist = (metrics: NormalisedMetric[]) => {
      const task = this.transport.persist(source, metrics).then(counts => {
        this.state.inserted += counts.inserted; this.state.skipped += counts.skipped;
        onProgress?.({ ...this.state });
      }).catch(error => { persistenceError ??= error; }).finally(() => { pending.delete(task); });
      pending.add(task);
    };
    const waitForCapacity = async () => {
      if (pending.size >= MAX_PENDING_BATCHES) await Promise.race(pending);
      if (persistenceError) {
        await Promise.all(pending);
        throw persistenceError;
      }
    };
    const flush = async (all = false) => {
      while (batch.length >= BATCH_SIZE || (all && batch.length)) {
        signal?.throwIfAborted();
        persist(batch.splice(0, BATCH_SIZE));
        await waitForCapacity();
      }
      if (all) {
        await Promise.all(pending);
        if (persistenceError) throw persistenceError;
      }
    };
    let lastReport = 0;
    // Both parsers consume small decoded slices, even if a decompressor emits a
    // large chunk. At most three persistence calls may be pending, retaining
    // backpressure while overlapping request authentication and network time.
    const consume = async (chunk: Uint8Array, write: (text: string) => void, decoder: TextDecoder) => {
      for (let offset = 0; offset < chunk.length; offset += 16384) {
        signal?.throwIfAborted();
        const part = chunk.subarray(offset, offset + 16384);
        write(decoder.decode(part, { stream: true }));
        this.state.bytes += part.length;
        await flush();
        if (Date.now() - lastReport > 150) { onProgress?.({ ...this.state }); lastReport = Date.now(); }
      }
    };
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      if (this.provider === "generic_csv") {
        this.state.totalBytes = this.file.size;
        const csv = new HealthCsvParser(acceptMetrics, this.options.timezone, this.options.filePath);
        const reader = this.file.stream().getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            await consume(value, text => csv.write(text), decoder);
          }
          csv.write(decoder.decode()); csv.close();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else {
        // BlobReader reads byte ranges. Passing a raw ReadableStream to ZipReader
        // instead would buffer the full archive to permit random access.
        configure({ chunkSize: 65536 });
        const zip = new ZipReader(new BlobReader(this.file), { useWebWorkers: false });
        try {
          let found = false;
          for await (const entry of zip.getEntriesGenerator()) {
            signal?.throwIfAborted();
            if (entry.directory || !/^(?:apple_health_export\/)?export\.xml$/.test(entry.filename)) continue;
            if (found) throw new Error("Archive contains more than one export.xml.");
            found = true;
            if (entry.encrypted) throw new Error("Encrypted Apple Health exports are not supported.");
            this.state.totalBytes = entry.uncompressedSize;
            const parser = new SaxesParser({ xmlns: false });
            let sinceEvent = 0, depth = 0;
            const boundary = () => { sinceEvent = 0; };
            parser.on("opentag", tag => {
              boundary();
              if (++depth > 64) throw new Error("XML nesting exceeds the supported limit.");
              if (tag.name === "Record") accept(tag.attributes);
            });
            parser.on("closetag", () => { boundary(); depth--; });
            parser.on("text", boundary); parser.on("comment", boundary); parser.on("doctype", boundary);
            const write = (text: string) => {
              sinceEvent += text.length;
              if (sinceEvent > 262144) throw new Error("An XML token is too large. No more data was imported.");
              parser.write(text);
            };
            await entry.getData(new WritableStream<Uint8Array>({ write: chunk => consume(chunk, write, decoder) }), { signal, checkSignature: true });
            write(decoder.decode()); parser.close();
          }
          if (!found) throw new Error("No export.xml was found in this Apple Health ZIP.");
        } finally { await zip.close(); }
      }
      await flush(true);
      this.state.status = "done";
      onProgress?.({ ...this.state });
      return { inserted: this.state.inserted, skipped: this.state.skipped, errors: [] };
    } catch (error) {
      const message = signal?.aborted ? "Import cancelled. Re-import the file to resume safely." : error instanceof Error ? error.message : "Import failed. Re-import to resume safely.";
      this.state.status = signal?.aborted ? "cancelled" : "error";
      this.state.errors = [message];
      onProgress?.({ ...this.state });
      throw error;
    }
  }
}
