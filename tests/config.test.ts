import { describe, expect, it } from "vitest";
import { validatePublicEnvironment } from "@/src/lib/config/public-env";

const valid = { url: "https://example.supabase.co", publishableKey: "sb_publishable_test" };

describe("public Supabase configuration", () => {
  it("accepts the new publishable key convention", () => {
    expect(validatePublicEnvironment(valid)).toEqual(valid);
  });
  it.each([undefined, ""])("rejects a missing URL: %s", (url) => {
    expect(() => validatePublicEnvironment({ ...valid, url })).toThrow("NEXT_PUBLIC_SUPABASE_URL");
  });
  it.each([undefined, "", "   ", "sb_secret_do-not-expose"])("rejects missing or secret keys", (publishableKey) => {
    expect(() => validatePublicEnvironment({ ...valid, publishableKey })).toThrow();
  });
  it.each(["invalid", "http://remote.example", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com?token=private"])("rejects unsafe public URL %s without echoing it", (url) => {
    expect(() => validatePublicEnvironment({ ...valid, url })).toThrow();
    try {
      validatePublicEnvironment({ ...valid, url });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(url);
    }
  });
  it("permits HTTP for local Supabase development", () => {
    expect(validatePublicEnvironment({ ...valid, url: "http://127.0.0.1:54321" }).url).toBe("http://127.0.0.1:54321");
  });
});
