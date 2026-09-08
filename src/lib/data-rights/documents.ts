import { z } from "zod";

export const DOCUMENT_BUCKET = "hms-documents";
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export const documentTypes = ["lab_report", "prescription", "discharge_summary", "other"] as const;
export const documentMimeTypes = ["application/pdf", "image/jpeg", "image/png"] as const;
export const documentInput = z.object({
  subject: z.uuid(), type: z.enum(documentTypes), title: z.string().trim().min(1).max(120),
});

export function documentExtension(mime: string) { return mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"; }

export function validDocumentSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "application/pdf") return bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (mime === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mime === "image/png" && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

/** Read raw bytes, not multipart/base64. Limits are checked on actual bytes. */
export async function readDocumentBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const mime = request.headers.get("content-type") || "";
  if (!documentMimeTypes.some(type => type === mime)) throw new Error("Choose a PDF, JPEG or PNG.");
  if (!request.body) throw new Error("Choose a document.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_DOCUMENT_BYTES) { await reader.cancel(); throw new Error("Documents must be at most 3 MiB."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (!validDocumentSignature(bytes, mime)) throw new Error("The file does not match its PDF, JPEG or PNG type.");
  return bytes;
}

/** A checked database path still must remain within this subject's exact prefix. */
export function checkedDocumentPath(subject: string, path: string): string {
  z.uuid().parse(subject);
  if (!path.startsWith(subject + "/") || path.includes("..") || path.includes("\\") || path.split("/").length !== 2 || !/^[a-zA-Z0-9._-]+$/u.test(path.split("/")[1])) {
    throw new Error("Document path is invalid.");
  }
  return path;
}
