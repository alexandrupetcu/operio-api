import { describe, expect, it } from "vitest";
import { osFeedState } from "./os-feed-state.js";

const w = { osRegistrationWarningDays: 2, osRegistrationDashboardDays: 4 };

describe("osFeedState — când apare fișa în panou și când e urgentă", () => {
  it("mai departe de pragul de afișare → nu apare", () => {
    expect(osFeedState(5, w)).toEqual({ show: false, urgent: false, overdue: false });
  });

  it("în fereastra de afișare, dar peste pragul urgent → apare, ne-urgentă", () => {
    expect(osFeedState(4, w)).toEqual({ show: true, urgent: false, overdue: false });
  });

  it("la pragul urgent → urgentă", () => {
    expect(osFeedState(2, w)).toEqual({ show: true, urgent: true, overdue: false });
    expect(osFeedState(0, w)).toEqual({ show: true, urgent: true, overdue: false });
  });

  it("termen depășit → apare mereu, chiar cu fereastra 0", () => {
    expect(osFeedState(-3, { osRegistrationWarningDays: 0, osRegistrationDashboardDays: 0 })).toEqual({
      show: true,
      urgent: true,
      overdue: true,
    });
  });
});
