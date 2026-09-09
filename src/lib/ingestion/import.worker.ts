import { UnsupportedCsvFormatError } from "./csv";
import { FileAdapter, type ImportProgress } from "./files";
import { httpTransport } from "./http";

export type ImportRequest = { action: "start"; userId: string; provider: "apple_health_export" | "generic_csv"; files: File[]; key: string; timezone: string } | { action: "cancel" };
let controller: AbortController | undefined;
self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  if (event.data.action === "cancel") { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController();
  const input = event.data;
  let reported = false, failureProgress: ImportProgress | undefined;
  try {
    const files = [...input.files].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    if (!files.length || files.length > 20_000) throw new Error("Choose between 1 and 20,000 health files.");
    if (input.provider === "apple_health_export" && (files.length !== 1 || !/\.zip$/i.test(files[0].name))) throw new Error("Choose one Apple Health ZIP.");
    if (input.provider === "generic_csv" && files.some(file => !/\.csv$/i.test(file.name))) throw new Error("Folders may contain CSV files only.");
    const transport = httpTransport(controller.signal), totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const source = await new FileAdapter(input.provider, files[0], transport).connect(input.userId, input.key);
    const totals = { inserted: 0, skipped: 0, records: 0, unsupported: 0, bytes: 0 };
    const displayName = (file: File) => (file.webkitRelativePath || file.name).slice(-500);
    const directory = (file: File) => { const path = file.webkitRelativePath || file.name, slash = path.lastIndexOf("/"); return slash < 0 ? "" : path.slice(0, slash); };
    const consolidated = new Set(files.filter(file => file.name.toLowerCase() === "daily activity metrics.csv").map(directory));
    let supportedFiles = 0, skippedFiles = 0;
    const warningSamples: string[] = [];
    const warnings = () => [...warningSamples, ...(skippedFiles > warningSamples.length ? ["And " + (skippedFiles - warningSamples.length).toLocaleString() + " more CSV files were skipped."] : [])];
    for (let index = 0; index < files.length; index++) {
      controller.signal.throwIfAborted();
      const file = files[index], fileName = displayName(file);
      if (consolidated.has(directory(file)) && /^\d{4}-\d{2}-\d{2}\.csv$/i.test(file.name)) {
        skippedFiles++; totals.bytes += file.size;
        if (warningSamples.length < 20) warningSamples.push("Skipped redundant daily CSV because Daily activity metrics.csv is present: " + fileName + ".");
        self.postMessage({ ...totals, totalBytes, status: "working", errors: warnings(), fileName, fileIndex: index + 1, fileCount: files.length, supportedFiles, skippedFiles });
        continue;
      }
      let latest: ImportProgress | undefined;
      const adapter = new FileAdapter(input.provider, file, transport, { signal: controller.signal, timezone: input.timezone, filePath: fileName, onProgress: progress => {
        latest = progress;
        failureProgress = { ...progress, inserted: totals.inserted + progress.inserted, skipped: totals.skipped + progress.skipped,
          records: totals.records + progress.records, unsupported: totals.unsupported + progress.unsupported,
          bytes: totals.bytes + progress.bytes, totalBytes, errors: warnings(),
          fileName, fileIndex: index + 1, fileCount: files.length, supportedFiles, skippedFiles };
        if (progress.status === "error" || progress.status === "cancelled") return;
        self.postMessage({ ...failureProgress, status: "working" });
      } });
      try {
        await adapter.sync(source); supportedFiles++;
      } catch (error) {
        if (!(error instanceof UnsupportedCsvFormatError) || input.provider !== "generic_csv" || files.length === 1) throw error;
        skippedFiles++; totals.bytes += file.size;
        if (warningSamples.length < 20) warningSamples.push("Skipped unsupported CSV: " + fileName + ".");
        self.postMessage({ ...totals, totalBytes, status: "working", errors: warnings(), fileName, fileIndex: index + 1, fileCount: files.length, supportedFiles, skippedFiles });
        continue;
      }
      if (!latest) throw new Error("The import did not report a result.");
      totals.inserted += latest.inserted; totals.skipped += latest.skipped; totals.records += latest.records;
      totals.unsupported += latest.unsupported; totals.bytes += file.size;
    }
    if (!supportedFiles) throw new Error("No supported health readings were found. Choose an HMS CSV, a legacy Google Fit Daily activity metrics export, or the complete Google Health Takeout folder.");
    reported = true;
    self.postMessage({ ...totals, bytes: totalBytes, totalBytes, status: "done", errors: warnings(),
      fileIndex: files.length, fileCount: files.length, supportedFiles, skippedFiles });
  } catch (error) {
    if (!reported) {
      const progress: ImportProgress = { ...(failureProgress || { inserted: 0, skipped: 0, records: 0, unsupported: 0, bytes: 0, totalBytes: 0 }),
        status: controller.signal.aborted ? "cancelled" : "error",
        errors: [error instanceof Error ? error.message : "Import failed. Re-import to resume safely."] };
      self.postMessage(progress);
    }
  } finally { controller = undefined; }
};
