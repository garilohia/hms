import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ database: vi.fn(), unsafe: vi.fn(), end: vi.fn(), bindActor: vi.fn(), lockOwnedSubject: vi.fn() }));
const actor = "eec32fc0-4cfa-4e3e-8404-5d38aefae640";
const subject = "eec32fc0-4cfa-4e3e-8404-5d38aefae641";
vi.mock("server-only", () => ({}));
vi.mock("@/src/lib/auth/server", () => ({ authenticatedClient: async () => ({ user: { id: "eec32fc0-4cfa-4e3e-8404-5d38aefae640" } }) }));
vi.mock("@/src/lib/data-rights/server", () => ({ rightsDatabase: mocks.database, bindActor: mocks.bindActor, lockOwnedSubject: mocks.lockOwnedSubject }));
import { GET } from "@/app/api/integrations/[provider]/connect/route";
import { integrationStatuses } from "@/src/lib/integrations/store";

describe("wearable quota setup readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unsafe.mockResolvedValue([]);
    mocks.database.mockReturnValue({ begin: (work: (tx: { unsafe: typeof mocks.unsafe }) => unknown) => work({ unsafe: mocks.unsafe }), end: mocks.end });
    vi.stubEnv("GOOGLE_HEALTH_CLIENT_ID", "synthetic-client");
    vi.stubEnv("GOOGLE_HEALTH_CLIENT_SECRET", "synthetic-secret");
    vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", "");
    vi.stubEnv("INTEGRATION_TOKEN_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("does not call a configured connector ready without its Google quota project", async () => {
    const statuses = await integrationStatuses(actor, subject);
    expect(statuses.find(status => status.provider === "google_health")?.configured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "not canonical"])("stops connect at setup for an invalid quota project: %s", async project => {
    vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", project);
    const response = await GET(new Request(`https://hms.example/api/integrations/google_health/connect?profile=${subject}`), { params: Promise.resolve({ provider: "google_health" }) });
    expect(response.headers.get("location")).toBe(`https://hms.example/more/data?profile=${subject}&integration=setup`);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still checks ownership and consent when valid quota configuration permits OAuth redirect", async () => {
    vi.stubEnv("GOOGLE_HEALTH_QUOTA_PROJECT_ID", "hms-test-project");
    const response = await GET(new Request(`https://hms.example/api/integrations/google_health/connect?profile=${subject}`), { params: Promise.resolve({ provider: "google_health" }) });
    expect(new URL(response.headers.get("location")!).origin).toBe("https://accounts.google.com");
    expect(mocks.lockOwnedSubject).toHaveBeenCalledExactlyOnceWith(expect.anything(), subject, true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
