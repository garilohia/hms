import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({ default: vi.fn(() => { throw new Error("Database access is forbidden in a configuration check."); }) }));
vi.mock("@/src/lib/jobs/summary-store", () => ({ createSummaryStore: vi.fn() }));
vi.mock("@/src/lib/jobs/summary-runner", () => ({ runSummaryJobs: vi.fn() }));
vi.mock("@/src/lib/alerts/delivery-store", () => ({ createDeliveryStore: vi.fn() }));
vi.mock("@/src/lib/alerts/dispatch", () => ({ dispatchAlerts: vi.fn() }));
vi.mock("@/src/lib/alerts/transport", () => ({ emailTransport: vi.fn(), pushTransport: vi.fn(), routedTransport: vi.fn() }));
vi.mock("@/src/lib/integrations/scheduled", () => ({ syncDueIntegrations: vi.fn() }));

import postgres from "postgres";
import { dispatchAlerts } from "@/src/lib/alerts/dispatch";
import { GET, POST } from "@/app/api/jobs/tick/route";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("authenticated notification configuration check", () => {
  const secret = "route-test-secret-".repeat(3);
  function setup() {
    vi.stubEnv("CRON_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "postgres://not-contacted.invalid/test");
    vi.stubEnv("RESEND_API_KEY", "re_private_fixture_value");
  }
  it("reveals no configuration to an unauthorised caller", async () => {
    setup();
    const response = await GET(new Request("https://hms.example.com/api/jobs/tick?check=notifications"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorised." });
    expect(postgres).not.toHaveBeenCalled();
  });
  it.each([GET, POST])("returns redacted checks without database, network or notification work", async method => {
    setup();
    const network = vi.spyOn(globalThis, "fetch");
    const response = await method(new Request("https://hms.example.com/api/jobs/tick?check=notifications", {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ senderDomainVerified: false, deliveryVerified: false, notificationsSent: 0 });
    expect(body.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: "resend_key", status: "pass" })]));
    expect(JSON.stringify(body)).not.toContain("re_private_fixture_value");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(postgres).not.toHaveBeenCalled();
    expect(dispatchAlerts).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["check=notification", "check=", "check", "check=other&check=notifications", "check=notifications&check=notifications"])("rejects malformed diagnostic %s without dispatch", async query => {
    setup();
    const network = vi.spyOn(globalThis, "fetch");
    const response = await POST(new Request(`https://hms.example.com/api/jobs/tick?${query}`, {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(postgres).not.toHaveBeenCalled();
    expect(dispatchAlerts).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
