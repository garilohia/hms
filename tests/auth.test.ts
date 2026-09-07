import { describe, expect, it } from "vitest";
import { dependentInput, isAdult, isValidBirthDate, safeNextPath, signInInput } from "@/src/lib/auth/validation";
describe("account boundaries", () => {
  const today = new Date("2026-09-08T00:00:00Z");
  it("accepts exactly 18 but rejects one day too young", () => {
    expect(isAdult("2008-09-08", today)).toBe(true);
    expect(isAdult("2008-09-09", today)).toBe(false);
  });
  it("rejects invalid, future, and implausibly old birthdates", () => {
    for (const date of ["2026-02-30","invalid","2027-01-01","1700-01-01"]) expect(isAdult(date,today)).toBe(false);
    expect(isValidBirthDate("2008-02-29")).toBe(true);
  });
  it("checks leap-day adulthood at the correct boundary", () => {
    expect(isAdult("2008-02-29",new Date("2026-02-28T00:00:00Z"))).toBe(false);
    expect(isAdult("2008-02-29",new Date("2026-03-01T00:00:00Z"))).toBe(true);
  });
  it("requires guardian consent for dependent creation", () => {
    expect(dependentInput.safeParse({name:"Sample child",dob:"2015-01-01",consent:false}).success).toBe(false);
    expect(dependentInput.safeParse({name:"Sample child",dob:"2015-01-01",consent:true}).success).toBe(true);
  });
  it("rejects minor self-signup before the Auth API is called", () => {
    expect(signInInput.safeParse({mode:"signup",email:"test@example.com",name:"Sample child",dob:"2015-01-01"}).success).toBe(false);
  });
  it.each(["https://evil.example","//evil.example","/\\evil.example","/\nevil.example"] )("rejects unsafe redirect %s", value => {
    expect(safeNextPath(value)).toBe("/account");
  });
  it("preserves a local path and its query", () => {
    expect(safeNextPath("/account?view=dependent")).toBe("/account?view=dependent");
  });
});
