import { describe, expect, it } from "vitest";
import { parseRevisionText } from "./revision-pdf-parser.js";

/** Blocul de analize exact cum îl dă `pdftotext -layout` pe un raport Seitron Chemist real. */
const ANALYSES = [
  "Analyses:",
  " Chemist 103 BE GREEN",
  " Numar Serial                                61010274",
  " Data                                        30/04/26",
  " Ora                                         15:33",
  " Combustibil                                 Gaz Natural",
  " Analiza 1",
  " T gaz                                       52.7 ° C",
  " T aer                                       -3.4 ° C",
  " O2                                          10.3 %",
  " CO                                          52 ppm",
  " dT                                          50.5 ° C",
].join("\n");

describe("parseRevisionText — temperaturi", () => {
  it("citește T gaz / T aer / dT tipărite ca „° C” (cu spațiu), inclusiv sub zero", () => {
    const r = parseRevisionText(ANALYSES);
    expect(r.analysisData?.readings).toMatchObject({ tGaz: "52.7 °C", tAer: "-3.4 °C", dT: "50.5 °C", o2: "10.3 %" });
  });

  it("acceptă în continuare „°C” lipit", () => {
    const r = parseRevisionText(" T gaz    48.3 °C\n dT    26.9°C");
    expect(r.analysisData?.readings).toMatchObject({ tGaz: "48.3 °C", dT: "26.9 °C" });
  });
});
