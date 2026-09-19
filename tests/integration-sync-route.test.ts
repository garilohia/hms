import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/auth/server", () => ({ authenticatedClient: vi.fn(), sameOrigin: vi.fn() }));
vi.mock("@/src/lib/integrations/sync", () => ({ syncIntegration: vi.fn() }));
vi.mock("@/src/lib/jobs/immediate", () => ({ processFreshHealthData: vi.fn() }));

import { POST } from "@/app/api/integrations/[provider]/sync/route";
import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { syncIntegration } from "@/src/lib/integrations/sync";
import { processFreshHealthData } from "@/src/lib/jobs/immediate";
import { ProviderRateLimitError } from "@/src/lib/integrations/rate-limit";

const subject = "3d14696a-9252-41da-a580-78e962fa4198";
const request = () => new Request("https://hms.example.invalid/api/integrations/whoop/sync", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: subject }),
});
const context = { params: Promise.resolve({ provider: "whoop" }) };

describe("manual wearable sync route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
    vi.mocked(sameOrigin).mockReturnValue(true);
    // The route uses only the server-verified actor ID, not the client or token.
    vi.mocked(authenticatedClient).mockResolvedValue({ user: { id: "verified-actor" } } as Awaited<ReturnType<typeof authenticatedClient>>);
  });
  afterEach(() => vi.useRealTimers());

  it("returns a private retry deadline without attempting the alert pipeline", async () => {
    vi.mocked(syncIntegration).mockRejectedValue(new ProviderRateLimitError(new Date(Date.now() + 90_500)));
    const response = await POST(request(), context);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("91");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "The wearable provider is limiting requests. Please try again later." });
    expect(syncIntegration).toHaveBeenCalledExactlyOnceWith("verified-actor", subject, "whoop");
    expect(processFreshHealthData).not.toHaveBeenCalled();
  });

  it("keeps unexpected provider errors redacted", async () => {
    vi.mocked(syncIntegration).mockRejectedValue(new Error("synthetic-private-provider-detail"));
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private-provider-detail");
    expect(response.headers.has("Retry-After")).toBe(false);
  });

  it("does not bypass origin or authentication checks for a cooldown", async () => {
    vi.mocked(sameOrigin).mockReturnValue(false);
    expect((await POST(request(), context)).status).toBe(403);
    expect(authenticatedClient).not.toHaveBeenCalled();
    vi.mocked(sameOrigin).mockReturnValue(true);
    vi.mocked(authenticatedClient).mockResolvedValue(null);
    expect((await POST(request(), context)).status).toBe(401);
    expect(syncIntegration).not.toHaveBeenCalled();
  });
});
