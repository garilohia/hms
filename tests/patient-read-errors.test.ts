import { afterEach, describe, expect, it, vi } from "vitest";
import { patientPost, readView } from "@/src/lib/patient/model";
import { isTransientReadError, PatientRequestError } from "@/src/lib/patient/read-errors";

afterEach(() => { vi.unstubAllGlobals(); });

describe("patient request errors", () => {
  it.each([400, 401, 403, 404, 408, 429, 500, 503])("preserves the safe message and HTTP %i", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Check current access." }, { status })));
    const error = await patientPost("/api/patient/view", {}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PatientRequestError);
    expect(error).toMatchObject({ message: "Check current access.", status });
    expect(isTransientReadError(error)).toBe([408, 429, 500, 503].includes(status));
  });

  it.each([401, 403, 503])("preserves HTTP %i when an upstream error body is not JSON", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>upstream detail</html>", { status })));
    const error = await patientPost("/api/patient/view", {}).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: "Please try again.", status });
    expect(isTransientReadError(error)).toBe(status === 503);
    expect(String(error)).not.toContain("upstream detail");
  });

  it("does not classify malformed successful JSON as a transient outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const error = await patientPost("/api/patient/view", {}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(isTransientReadError(error)).toBe(false);
  });

  it("does not hide schema errors in successful views", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ incomplete: true })));
    const error = await readView("00000000-0000-4000-8000-000000000001", "today").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(isTransientReadError(error)).toBe(false);
  });

  it("preserves network and timeout failures for bounded read-only recovery", async () => {
    for (const error of [new TypeError("Failed to fetch"), new DOMException("Timed out", "TimeoutError")]) {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      await expect(patientPost("/api/patient/view", {})).rejects.toBe(error);
      expect(isTransientReadError(error)).toBe(true);
    }
    expect(isTransientReadError(new DOMException("Aborted", "AbortError"))).toBe(false);
  });

  it("does not retry writes in the shared request helper", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(patientPost("/api/patient/refresh", {})).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
