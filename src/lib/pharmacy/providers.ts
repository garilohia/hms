import { z } from "zod";

export type PharmacySearchLink = { kind: "search_link"; id: string; query: string; provider: "tata1mg" | "apollo247"; prefilled: boolean };
export interface PharmacyProvider {
  search(query: string): Promise<PharmacySearchLink[]>;
  getProduct(id: string): Promise<null>;
  deepLink(product: PharmacySearchLink): string;
}
const searchQuery = z.string().trim().min(2).max(100).refine(text => !/[\u0000-\u001f\u007f]/u.test(text), "Use a short product search.");

/** Link-only stub. No inventory, prescription, price, stock or partner API. */
export class Tata1mgProvider implements PharmacyProvider {
  async search(query: string): Promise<PharmacySearchLink[]> {
    const term = searchQuery.parse(query);
    return [{ kind: "search_link", id: "search:" + term, query: term, provider: "tata1mg", prefilled: true }];
  }
  async getProduct(id: string): Promise<null> { z.string().max(200).parse(id); return null; }
  deepLink(product: PharmacySearchLink): string {
    if (product.provider !== "tata1mg") throw new Error("Wrong pharmacy provider.");
    return "https://www.1mg.com/search/all?" + new URLSearchParams({ name: searchQuery.parse(product.query) });
  }
}

/** Apollo 24|7 redirects its medicines area to Apollo Pharmacy. Its public
 * search UI does not expose a verified shareable query URL. Open that actual
 * search page and ask the user to enter the term; never invent a working link.
 */
export class Apollo247Provider implements PharmacyProvider {
  async search(query: string): Promise<PharmacySearchLink[]> {
    const term = searchQuery.parse(query);
    return [{ kind: "search_link", id: "search:" + term, query: term, provider: "apollo247", prefilled: false }];
  }
  async getProduct(id: string): Promise<null> { z.string().max(200).parse(id); return null; }
  deepLink(product: PharmacySearchLink): string {
    if (product.provider !== "apollo247") throw new Error("Wrong pharmacy provider.");
    searchQuery.parse(product.query);
    return "https://www.apollopharmacy.in/search-medicines";
  }
}
