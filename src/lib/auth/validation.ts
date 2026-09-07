import { z } from "zod";

export function isValidBirthDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function isAdult(dob: string, now = new Date()) {
  if (!isValidBirthDate(dob)) return false;
  const today = now.toISOString().slice(0, 10);
  const cutoff = String(now.getUTCFullYear() - 18) + today.slice(4);
  const earliest = String(now.getUTCFullYear() - 120) + today.slice(4);
  return dob <= cutoff && dob >= earliest;
}
export function safeNextPath(input: string | null, fallback = "/account") {
  if (!input?.startsWith("/") || input.startsWith("//") || /[\\\u0000-\u001f]/.test(input)) return fallback;
  const parsed = new URL(input, "https://hms.invalid");
  return parsed.origin === "https://hms.invalid" ? parsed.pathname + parsed.search : fallback;
}
export const signInInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("signin"), email: z.email().max(254) }),
  z.object({ mode: z.literal("signup"), email: z.email().max(254), name: z.string().trim().min(1).max(120), dob: z.string().refine(isAdult, "An adult guardian must create a dependent profile for under-18s.") }),
]);
export const dependentInput = z.object({
  name: z.string().trim().min(1).max(120),
  dob: z.string().refine(d => {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = String(new Date().getUTCFullYear() - 18) + today.slice(4);
    return isValidBirthDate(d) && d <= today && d > cutoff;
  }, "Enter a valid date of birth for an under-18 dependent."),
  consent: z.literal(true),
});
