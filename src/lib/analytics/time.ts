const DAY = 86400000;
export function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const epoch = Date.parse(day + "T00:00:00Z");
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === day;
}
export function addDays(day: string, count: number): string {
  if (!validDay(day) || !Number.isInteger(count)) throw new Error("A valid calendar day and whole-day offset are required.");
  return new Date(Date.parse(day + "T00:00:00Z") + count * DAY).toISOString().slice(0, 10);
}
export function daysBetween(start: string, end: string) {
  if (!validDay(start) || !validDay(end)) throw new Error("Invalid calendar day.");
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY);
}
// Bounded memoisation of timezone formatters; results never depend on the clock.
const formats = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { calendar: "iso8601", numberingSystem: "latn", timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    if (formats.size >= 32) formats.delete(formats.keys().next().value!);
    formats.set(timezone, format);
  }
  return format;
}
function parts(epoch: number, format: Intl.DateTimeFormat) { return Object.fromEntries(format.formatToParts(epoch).map(p => [p.type, p.value])); }
function dayAt(epoch: number, format: Intl.DateTimeFormat) { const p = parts(epoch, format); return p.year.padStart(4, "0") + "-" + p.month + "-" + p.day; }
export function localDay(timestamp: string | number, timezone = "UTC") {
  return dayAt(typeof timestamp === "number" ? timestamp : Date.parse(timestamp), formatter(timezone));
}
export function localHour(timestamp: string | number, timezone = "UTC") {
  return Number(parts(typeof timestamp === "number" ? timestamp : Date.parse(timestamp), formatter(timezone)).hour);
}
/** Search for the first instant of the local date. Unlike adding 24 hours, this
 * handles 23/25-hour days, non-hour offsets and transitions at midnight. */
export function dayBounds(day: string, timezone = "UTC") {
  if (!validDay(day)) throw new Error("Invalid calendar day.");
  const format = formatter(timezone);
  function startOf(target: string) {
    const centre = Date.parse(target + "T00:00:00Z");
    let low = centre - 2 * DAY, high = centre + 2 * DAY;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dayAt(middle, format) < target) low = middle + 1; else high = middle;
    }
    return low;
  }
  return { start: startOf(day), end: startOf(addDays(day, 1)) };
}
