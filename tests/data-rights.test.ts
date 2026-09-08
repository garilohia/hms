import { describe, expect, it } from "vitest";
import { BlobReader, TextReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import { byteStream, csvCell, csvLine, jsonLines, streamedArchive } from "@/src/lib/data-rights/archive";
import { checkedDocumentPath, MAX_DOCUMENT_BYTES, readDocumentBody, validDocumentSignature } from "@/src/lib/data-rights/documents";

describe("portable exports", () => {
  it("quotes CSV and neutralises untrusted formulas without changing numbers", () => {
    expect(csvCell('a,"b"\n')).toBe('"a,""b""\n"');
    expect(csvLine(["timestamp", -0.5, null, "=SUM(A1)", " +123", "@value"])).toBe("timestamp,-0.5,,'=SUM(A1),' +123,'@value\r\n");
  });
  it("streams a valid multi-entry archive with exact rows", async () => {
    const archive = streamedArchive(async writer => {
      await writer.add("metrics/steps.csv", new TextReader(csvLine(["timestamp", "metric_type", "value", "unit"]) + csvLine(["2026-09-01T12:00:00Z", "steps", 42, "count"])));
      async function* rows() { for (let i = 0; i < 2100; i++) yield { id: i, name: "Sample data" }; }
      await writer.add("records.jsonl", byteStream(jsonLines(rows())));
    });
    const blob = await new Response(archive.readable).blob(); await archive.completed;
    const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
    try {
      const entries = await reader.getEntries(); expect(entries.map(entry => entry.filename)).toEqual(["metrics/steps.csv", "records.jsonl"]);
      const [metric, record] = entries; if (metric.directory || record.directory) throw new Error("Expected files");
      expect(await metric.getData(new TextWriter())).toContain("2026-09-01T12:00:00Z,steps,42,count");
      expect((await record.getData(new TextWriter())).trim().split("\n")).toHaveLength(2100);
    } finally { await reader.close(); }
  });
  it("fails the stream if an original document cannot be read", async () => {
    const archive = streamedArchive(async writer => { await writer.add("first.txt", new TextReader("first")); throw new Error("Missing original"); });
    await expect(new Response(archive.readable).blob()).rejects.toThrow("Missing original");
    await expect(archive.completed).rejects.toThrow("Missing original");
  });
  it("propagates download cancellation to the producer", async () => {
    let aborted = false;
    const archive = streamedArchive(async (writer, signal) => {
      async function* chunks() { try { while (true) { signal.throwIfAborted(); yield new Uint8Array(4096); } } finally { aborted = true; } }
      await writer.add("large.bin", byteStream(chunks(), signal), { signal });
    });
    const reader = archive.readable.getReader(); await reader.read(); await reader.cancel("Download cancelled");
    await expect(archive.completed).rejects.toBeDefined(); expect(aborted).toBe(true);
  });
});

describe("document boundaries", () => {
  it("rejects false MIME types and HTML masquerading as a PDF", async () => {
    expect(validDocumentSignature(new TextEncoder().encode("<script>bad</script>"), "application/pdf")).toBe(false);
    await expect(readDocumentBody(new Request("https://hms.test", { method: "POST", body: "<script>", headers: { "content-type": "image/svg+xml" } }))).rejects.toThrow("PDF, JPEG or PNG");
  });
  it("enforces the actual limit and accepts a small PDF", async () => {
    const request = (body: Uint8Array<ArrayBuffer>) => new Request("https://hms.test", { method: "POST", body, headers: { "content-type": "application/pdf", "content-length": "8" } });
    await expect(readDocumentBody(request(new Uint8Array(MAX_DOCUMENT_BYTES + 1)))).rejects.toThrow("3 MiB");
    expect(await readDocumentBody(request(new TextEncoder().encode("%PDF-1.7\n")))).toHaveLength(9);
  });
  it("never resolves another profile or traversal path", () => {
    const subject = "11111111-1111-4111-8111-111111111111";
    expect(checkedDocumentPath(subject, subject + "/document.pdf")).toBe(subject + "/document.pdf");
    for (const path of ["other/document.pdf", subject + "/../private", subject + "/a/b", subject + "/a\\b"]) expect(() => checkedDocumentPath(subject, path)).toThrow();
  });
});
