import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewSchema, type PatientView } from "@/src/lib/patient/model";

const mocks = vi.hoisted(() => ({ patientPage: vi.fn(), careRead: vi.fn(), realtime: vi.fn() }));
vi.mock("@/src/lib/patient/server", () => ({ patientPage: mocks.patientPage }));
vi.mock("@/src/lib/care/server", () => ({ careRead: mocks.careRead }));
vi.mock("@/src/lib/patient/realtime", () => ({ useRealtimePatientView: mocks.realtime }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), usePathname: () => "/history" }));
import TodayPage from "@/app/today/page";
import HistoryPage from "@/app/history/page";
import { Today } from "@/app/today/today";
import { History } from "@/app/history/history";
import { ConsultNotes } from "@/app/history/consult-notes";

function view(id: string, displayMode: "simple" | "standard" | "advanced" = "standard") {
  return viewSchema.parse({ profile: { id, name: "Sample profile", dob: "1990-01-01", kind: "self", timezone: "UTC",
    sex_at_birth: null, country_of_residence: "IN", onboarding_completed_at: "2026-09-19T00:00:00Z",
    cycle_tracking_enabled: false, display_mode: displayMode }, can_manage: true, can_read_history: true,
    can_read_alerts: true, consent_given_by_guardian: false, summaries: [], stale_days: [] });
}
const firstId = "00000000-0000-4000-8000-000000000001", secondId = "00000000-0000-4000-8000-000000000002";
function childKey(node: ReactNode, type: unknown) {
  if (!isValidElement<{ children?: ReactNode }>(node)) throw new Error("Page element missing.");
  const child = Children.toArray(node.props.children).find(value => isValidElement(value) && value.type === type);
  if (!isValidElement(child)) throw new Error("Patient child missing.");
  return child.key;
}

beforeEach(() => { vi.clearAllMocks(); mocks.careRead.mockResolvedValue({ rows: [], next_cursor: null }); });

describe("patient navigation state boundaries", () => {
  it("changes Today identity with the profile so readings and status cannot survive a profile switch", async () => {
    const keys = [];
    for (const id of [firstId, secondId]) {
      const initial = view(id);
      mocks.patientPage.mockResolvedValue({ view: initial, profiles: [initial.profile], today: "2026-09-19" });
      keys.push(childKey(await TodayPage({ searchParams: Promise.resolve({ profile: id }) }), Today));
    }
    expect(keys[0]).toContain(firstId);
    expect(keys[1]).toContain(secondId);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("resets both History and consultation notes when the viewed profile changes", async () => {
    const keys = [];
    for (const id of [firstId, secondId]) {
      const initial = view(id);
      mocks.patientPage.mockResolvedValue({ view: initial, profiles: [initial.profile], today: "2026-09-19" });
      const page = await HistoryPage({ searchParams: Promise.resolve({ profile: id }) });
      keys.push([childKey(page, History), childKey(page, ConsultNotes)]);
    }
    expect(keys[0].every(key => key?.includes(firstId))).toBe(true);
    expect(keys[1].every(key => key?.includes(secondId))).toBe(true);
    expect(new Set(keys[0]).size).toBe(2);
    expect(keys[0]).not.toEqual(keys[1]);
  });
});

describe("History read recovery status", () => {
  it.each(["simple", "standard", "advanced"] as const)("shows preserved exhausted/auth failures in %s mode", mode => {
    mocks.realtime.mockImplementation((initial: PatientView) => ({ view: initial, setView: vi.fn(), live: "offline",
      retrying: false, readError: "You do not have access to this view.", suspendReads: vi.fn() }));
    const markup = renderToStaticMarkup(createElement(History, { initial: view(firstId, mode), today: "2026-09-19" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("You do not have access to this view.");
    expect(markup).not.toContain("retrying automatically");
  });

  it.each(["simple", "standard", "advanced"] as const)("claims automatic recovery only while retrying in %s mode", mode => {
    mocks.realtime.mockImplementation((initial: PatientView) => ({ view: initial, setView: vi.fn(), live: "offline",
      retrying: true, readError: "Failed to fetch", suspendReads: vi.fn() }));
    const markup = renderToStaticMarkup(createElement(History, { initial: view(firstId, mode), today: "2026-09-19" }));
    expect(markup).toContain("Live connection interrupted; retrying automatically");
  });
});
