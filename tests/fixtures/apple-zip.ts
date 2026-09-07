import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { ZipWriter } from "@zip.js/zip.js";

/** Real quantity records, not padding/comments. Repeated records exercise the
 * same dedupe path as overlapping exports while bounding synthetic DB storage. */
export async function generateAppleFixture(path: string, minimumBytes = 210 * 1024 * 1024) {
  const encoder = new TextEncoder();
  let bytes = 0, records = 0, started = false, ended = false;
  const distinct = 6000;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (ended) { controller.close(); return; }
      let text = "";
      if (!started) { text = '<?xml version="1.0" encoding="UTF-8"?><HealthData locale="en_IN">\n'; started = true; }
      for (let n = 0; n < 256 && bytes + text.length < minimumBytes; n++) {
        const i = records % distinct;
        const time = new Date(Date.UTC(2026, 5, 1) + i * 60000).toISOString().replace("T", " ").replace(".000Z", " +0000");
        text += '<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Sample fixture watch" sourceVersion="1" unit="count/min" creationDate="' + time + '" startDate="' + time + '" endDate="' + time + '" value="' + (60 + i % 15) + '" device="&lt;HKDevice: 0x123, name: Sample watch, manufacturer: Sample, model: Watch, hardware: Fixture1&gt;"/>\n';
        records++;
      }
      if (bytes + text.length >= minimumBytes) { text += "</HealthData>"; ended = true; }
      const chunk = encoder.encode(text); bytes += chunk.length; controller.enqueue(chunk);
    },
  });
  const file = createWriteStream(path);
  const writer = new ZipWriter(Writable.toWeb(file) as WritableStream<Uint8Array>, { useWebWorkers: false });
  await writer.add("apple_health_export/export.xml", stream);
  await writer.close();
  return { bytes, records, distinct };
}
