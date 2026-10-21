import { describe, expect, it } from "vitest";
import { osBoxData } from "./os-box.js";

describe("osBoxData — caseta „Înregistrat la” de pe documente", () => {
  it("după înregistrare: distribuitorul instalației, numărul și data", () => {
    expect(
      osBoxData({ osRegistrationNumber: "12345", osRegisteredAt: new Date(2026, 9, 21), installation: { distributorName: "Distrigaz Sud Rețele" } }, "Delgaz"),
    ).toEqual({ os_denumire: "Distrigaz Sud Rețele", os_nr_inregistrare: "12345", os_data_inregistrare: "21.10.2026" });
  });

  it("fără distribuitor pe instalație → operatorul din setările firmei", () => {
    expect(osBoxData({ osRegistrationNumber: null, osRegisteredAt: null, installation: null }, "DISTRIGAZ SUD REȚELE").os_denumire).toBe("DISTRIGAZ SUD REȚELE");
  });

  it("neînregistrat încă → linii de completat, nu numele firmei sau numărul din registratură", () => {
    const d = osBoxData(null, "");
    expect(d.os_nr_inregistrare).toBe("______________");
    expect(d.os_data_inregistrare).toBe("______________");
    expect(d.os_denumire).toBe("______________");
  });
});
