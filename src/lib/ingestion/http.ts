import { z } from "zod";
import { MAX_BODY_BYTES, type IngestionTransport } from "./model";

/** Count actual bytes, not a caller-controlled Content-Length. */
export async function boundedJson(request: Request, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Use JSON batches.");
  if (!request.body) throw new Error("A request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Batch exceeds the byte limit."); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export function httpTransport(signal?: AbortSignal): IngestionTransport {
  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
  async function post(path: string, body: unknown) {
    const data = JSON.stringify(body);
    if (new TextEncoder().encode(data).byteLength > MAX_BODY_BYTES) throw new Error("Batch exceeds the byte limit.");
    // An uncertain response is safe to retry: source keys and metric keys are idempotent.
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const deadline = AbortSignal.timeout(30_000);
        const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: data,
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
        if ((response.status >= 500 || response.status === 429) && attempt < 2) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter ? Number(retryAfter) : NaN;
          const delay = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 1000 * (attempt + 1);
          if (!Number.isFinite(delay) || delay > 30_000) throw new RequestError("The service is busy. Try importing again later.");
          await response.body?.cancel();
          await pause(Math.max(500, delay)); continue;
        }
        const result: unknown = await response.json().catch(() => ({ error: "Import request failed. Re-import to resume safely." }));
        if (!response.ok) {
          const parsed = z.object({ error: z.string() }).safeParse(result);
          throw new RequestError(parsed.success ? parsed.data.error : "Import request failed.");
        }
        return result;
      } catch (error) {
        if (error instanceof RequestError || signal?.aborted || attempt === 2) throw error;
        await pause(1000 * (attempt + 1));
      }
    }
    throw new Error("Import request failed. Re-import to resume safely.");
  }
  return {
    async connect(userId, provider, key) {
      const { id } = z.object({ id: z.uuid() }).parse(await post("/api/ingestion/sources", { userId, provider, key }));
      return { id, userId, provider, key };
    },
    async persist(source, metrics) {
      return z.object({ inserted: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).parse(
        await post("/api/ingestion/batches", { userId: source.userId, sourceId: source.id, metrics }));
    },
  };
}
class RequestError extends Error {}
