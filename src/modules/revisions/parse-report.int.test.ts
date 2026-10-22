import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { previewReportFile } from "../appointments/import-report.js";

/**
 * Precompletarea din web: raportul analizorului se citește înainte ca vizita să existe,
 * fără nicio scriere — doar citirile și valorile pentru pasul „Verificări funcționale”.
 */
let app: FastifyInstance;
let f: TwoTenants;

const SEITRON_TXT = [
  "                         SEITRON  Chemist 500",
  "",
  "Operator:            Ion Popescu",
  "Client:              Maria Ionescu",
  "Equipment:           Centrala Viessmann Vitodens 100",
  "Numar Serial         7512345678",
  "",
  "Analyses:",
  "Analiza 1            18/10/2026  09:30",
  "  O2          4.5 %",
  "  CO          38 ppm",
  "  Tiraj       -12 Pa",
  "  Randament   93.1 %",
].join("\n");

const txt = (text: string, filename = "raport.txt") => ({ buffer: Buffer.from(text, "utf8"), filename, mimetype: "text/plain" });

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("previewReportFile", () => {
  it("detectează sursa și întoarce citirile + precompletarea, fără să scrie nimic", async () => {
    const before = await prisma.equipmentRevision.count();
    const r = await previewReportFile(app, f.a.id, "revizie", txt(SEITRON_TXT));
    expect(r.sourceId).toBe("seitron-pdf");
    expect(r.readings).toMatchObject({ o2: expect.anything(), co: expect.anything() });
    expect(r.prefill.co).toBe("38");
    expect(r.prefill.o2).toBe("4.5");
    expect(r.prefill.draftValue).toBe("-0.12"); // Pa → mbar
    expect(r.warning).toBeNull();
    expect(await prisma.equipmentRevision.count()).toBe(before);
  });

  it("un fișier de neînțeles nu aruncă: sursa „doar atașare”, fără precompletare", async () => {
    const r = await previewReportFile(app, f.a.id, "revizie", txt("nimic relevant aici"));
    expect(r.prefill).toEqual({});
    expect(r.readings).toEqual({});
  });

  it("tipul de vizită fără import de raport → 400", async () => {
    const err = await expectReject(() => previewReportFile(app, f.a.id, "general", txt(SEITRON_TXT)));
    expect(err.status).toBe(400);
  });
});
