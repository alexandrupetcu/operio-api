import { describe, expect, it } from "vitest";
import { finalizeAppointmentSchema } from "./appointments.schema.js";

/** Raport de centrală minim valid; semnătura clientului fără e-mail (clientul nu are). */
const raportComplet = (clientEmail: unknown) => ({
  outcome: "raport_complet",
  reportData: {
    verificationType: "verificare_periodica",
    verificationDocuments: { instructions: "DA", conformityDeclaration: "DA", thermoMechanicalSchema: "DA", repairDocumentation: "NA", fuelNotice: "DA" },
    workVerification: { installedCorrect: "DA", repairedCorrect: "NA", connectionGas: "DA", connectionElectricity: "DA", connectionWater: "DA", flueGas: "DA", fuelMatch: "DA", combustionAir: "DA" },
    functionalVerifications: { fuelSealingCheck: "DA", waterSealingCheck: "DA", grounding: "DA", flueGasSealingCheck: "DA", protectionFunctionsCheck: "DA" },
    conclusions: { decision: "admis", nextRevisionDate: "2028-10-27" },
    clientSignature: { signatureDataUrl: "data:image/png;base64,AAAA", gdprConsent: true, clientEmail },
  },
});

describe("finalizare raport centrală — e-mailul clientului", () => {
  it("„” (client fără e-mail, așa trimite telefonul) înseamnă fără e-mail, nu e-mail invalid", () => {
    const parsed = finalizeAppointmentSchema.parse(raportComplet(""));
    expect((parsed as any).reportData.clientSignature.clientEmail).toBeUndefined();
  });
  it("un e-mail valid trece, unul invalid pică", () => {
    expect((finalizeAppointmentSchema.parse(raportComplet("ion@exemplu.ro")) as any).reportData.clientSignature.clientEmail).toBe("ion@exemplu.ro");
    expect(() => finalizeAppointmentSchema.parse(raportComplet("ion@"))).toThrow();
  });
});
