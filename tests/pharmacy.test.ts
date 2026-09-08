import { describe, expect, it } from "vitest";
import { Apollo247Provider, Tata1mgProvider } from "@/src/lib/pharmacy/providers";

describe("pharmacy link-only stubs", () => {
  it("encodes a Tata search without inventing a product or price", async () => {
    const provider = new Tata1mgProvider(), [result] = await provider.search("test & thing #1");
    const url = new URL(provider.deepLink(result));
    expect(url.hostname).toBe("www.1mg.com"); expect(url.searchParams.get("name")).toBe("test & thing #1");
    expect([...url.searchParams.keys()]).toEqual(["name"]); expect(url.hash).toBe("");
    expect(result.kind).toBe("search_link"); expect(await provider.getProduct("123")).toBeNull();
  });
  it("opens the verified Apollo search page with an explicit no-prefill flag", async () => {
    const provider = new Apollo247Provider(), [result] = await provider.search("bandage");
    expect(result.prefilled).toBe(false); expect(provider.deepLink(result)).toBe("https://www.apollopharmacy.in/search-medicines");
    expect(await provider.getProduct("123")).toBeNull();
  });
  it("rejects controls, overlong queries and provider confusion", async () => {
    const tata = new Tata1mgProvider(), apollo = new Apollo247Provider();
    for (const term of ["a", "a".repeat(101), "hello\u0000world"]) await expect(tata.search(term)).rejects.toThrow();
    expect(() => tata.deepLink({ kind: "search_link", id: "x", query: "test", provider: "apollo247", prefilled: false })).toThrow();
    expect(() => apollo.deepLink({ kind: "search_link", id: "x", query: "test", provider: "tata1mg", prefilled: true })).toThrow();
  });
});
