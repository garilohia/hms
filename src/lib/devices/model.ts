import { z } from "zod";
import { metricTypes } from "../ingestion/model";

const amount = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]).pipe(z.number().finite().nonnegative()).nullable();
export const deviceSchema = z.object({
  brand: z.string().min(1).max(100), model: z.string().min(1).max(150),
  category: z.enum(["watch", "band", "ring", "scale", "bp_cuff", "cgm"]),
  price_inr: amount, price_usd: amount, price_gbp: amount, price_aed: amount,
  metrics_supported: z.array(z.enum(metricTypes)), battery_days: amount,
  has_ecg: z.boolean(), has_skin_temp: z.boolean(), has_spo2: z.boolean(), has_hrv: z.boolean(), has_screen: z.boolean(),
  subscription_required: z.boolean(), subscription_cost: z.string().nullable(),
  update_class: z.enum(["live", "near_realtime", "delayed", "manual", "partner"]),
  connection_path: z.string().min(1).max(160), latency_label: z.string().min(1).max(240), realtime_capable: z.boolean(),
  source_urls: z.array(z.url().refine(s => new URL(s).protocol === "https:")).min(1),
  last_verified_at: z.iso.datetime({ offset: true }), editorial_note: z.string().min(1),
});
export type Device = z.infer<typeof deviceSchema>;
export const currencies = ["INR", "USD", "GBP", "AED"] as const;
export type Currency = typeof currencies[number];
export const featureLabels = { has_skin_temp: "Skin temperature", has_spo2: "SpO₂", has_hrv: "HRV", has_ecg: "ECG" } as const;
export type Feature = keyof typeof featureLabels;
export type Filters = { currency: Currency; budget: "any" | "entry" | "mid" | "premium"; features: Feature[]; battery: number; screen: "any" | "yes" | "no"; updates: "any" | Device["update_class"] };
export const budgetEdges: Record<Currency, readonly [number, number]> = { INR: [10000, 30000], USD: [150, 400], GBP: [150, 350], AED: [600, 1500] };
export const defaultFilters: Filters = { currency: "INR", budget: "any", features: [], battery: 0, screen: "any", updates: "any" };
export function priceOf(device: Device, currency: Currency) {
  return device[({ INR: "price_inr", USD: "price_usd", GBP: "price_gbp", AED: "price_aed" } as const)[currency]];
}
export function money(value: number, currency: Currency) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}
export function verifiedDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}
export function filterDevices(devices: Device[], filter: Filters) {
  const [low, high] = budgetEdges[filter.currency];
  return devices.filter(d => {
    const price = priceOf(d, filter.currency);
    if (filter.budget !== "any" && (price === null || (filter.budget === "entry" ? price >= low : filter.budget === "mid" ? price < low || price >= high : price < high))) return false;
    return filter.features.every(feature => d[feature]) && (filter.battery === 0 || (d.battery_days !== null && d.battery_days >= filter.battery))
      && (filter.screen === "any" || d.has_screen === (filter.screen === "yes")) && (filter.updates === "any" || d.update_class === filter.updates);
  }).sort((a, b) => (priceOf(a, filter.currency) ?? Infinity) - (priceOf(b, filter.currency) ?? Infinity) || (a.brand + a.model).localeCompare(b.brand + b.model));
}
