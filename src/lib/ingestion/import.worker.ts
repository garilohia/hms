import { FileAdapter, type ImportProgress } from "./files";
import { httpTransport } from "./http";

export type ImportRequest = { action: "start"; userId: string; provider: "apple_health_export" | "generic_csv"; file: File; key: string } | { action: "cancel" };
let controller: AbortController | undefined;
self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  if (event.data.action === "cancel") { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController();
  const input = event.data;
  let reported = false;
  try {
    const adapter = new FileAdapter(input.provider, input.file, httpTransport(controller.signal), {
      signal: controller.signal, onProgress: progress => { reported = progress.status !== "working"; self.postMessage(progress); },
    });
    const source = await adapter.connect(input.userId, input.key);
    await adapter.sync(source);
  } catch (error) {
    if (!reported) {
      const progress: ImportProgress = { status: controller.signal.aborted ? "cancelled" : "error", inserted: 0, skipped: 0, records: 0, unsupported: 0, bytes: 0, totalBytes: 0,
        errors: [error instanceof Error ? error.message : "Import failed. Re-import to resume safely."] };
      self.postMessage(progress);
    }
  } finally { controller = undefined; }
};
