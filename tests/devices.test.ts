import { describe, expect, it } from "vitest";
import { catalog } from "../src/lib/devices/catalog";
import { currencies, defaultFilters, deviceSchema, filterDevices, money, priceOf, verifiedDate } from "../src/lib/devices/model";

describe("dated manufacturer catalogue", () => {
  it("covers all six categories with at least 18 unique, sourced devices", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(18);
    expect(new Set(catalog.map(d => d.brand + "/" + d.model)).size).toBe(catalog.length);
    expect(new Set(catalog.map(d => d.category)).size).toBe(6);
    expect(catalog.every(d => deviceSchema.safeParse(d).success && d.last_verified_at === "2026-09-08T00:00:00Z")).toBe(true);
    expect(catalog.filter(d => d.brand === "Apple").every(d => !d.metrics_supported.includes("hrv_rmssd"))).toBe(true);
  });
  it("keeps unknown prices unknown in every currency and applies half-open budget bands", () => {
    const d = catalog[0];
    expect(priceOf({ ...d, price_usd: null }, "USD")).toBeNull();
    for (const currency of currencies) expect(money(99.99, currency)).toContain("99.99");
    const rows = [0, 149.99, 150, 399.99, 400, null].map(price => ({ ...d, price_usd: price }));
    expect(filterDevices(rows, { ...defaultFilters, currency: "USD", budget: "entry" }).map(r => r.price_usd)).toEqual([0, 149.99]);
    expect(filterDevices(rows, { ...defaultFilters, currency: "USD", budget: "mid" }).map(r => r.price_usd)).toEqual([150, 399.99]);
    expect(filterDevices(rows, { ...defaultFilters, currency: "USD", budget: "premium" }).map(r => r.price_usd)).toEqual([400]);
    expect(filterDevices(rows, { ...defaultFilters, currency: "USD" }).at(-1)?.price_usd).toBeNull();
  });
  it("requires every chosen feature, excludes unknown batteries and handles no-screen devices", () => {
    const rows = filterDevices(catalog, { ...defaultFilters, features: ["has_skin_temp", "has_spo2", "has_hrv"], battery: 7, screen: "no" });
    expect(rows.map(d => d.brand)).toContain("Oura");
    expect(rows.every(d => d.has_skin_temp && d.has_spo2 && d.has_hrv && !d.has_screen && d.battery_days !== null && d.battery_days >= 7)).toBe(true);
    expect(filterDevices(catalog, { ...defaultFilters, battery: 1 }).some(d => d.category === "cgm")).toBe(false);
  });
  it("rejects malformed data and unsafe links without coercing missing values to zero", () => {
    for (const price of ["", "NaN", "Infinity", -1, Infinity, false, undefined]) expect(deviceSchema.safeParse({ ...catalog[0], price_inr: price }).success).toBe(false);
    expect(deviceSchema.safeParse({ ...catalog[0], source_urls: ["javascript:alert(1)"] }).success).toBe(false);
    expect(deviceSchema.parse({ ...catalog[0], price_inr: "1499.00" }).price_inr).toBe(1499);
    expect(verifiedDate(catalog[0].last_verified_at)).toBe("8 Sept 2026");
  });
});
