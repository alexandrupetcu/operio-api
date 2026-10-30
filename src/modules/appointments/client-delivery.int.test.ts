import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as revisions from "../revisions/revisions.service.js";
import { createDirectRevisionSchema } from "../revisions/revisions.schema.js";
import { osRegistrationAttachments } from "./os-registration.js";

/**
 * Revizia / verificarea ajunge la client abia după numărul de la OS: la finalizare nu
 * pleacă niciun e-mail; e-mailul de înregistrare duce fișa cu numărul + restul setului.
 */
let app: FastifyInstance;
let f: TwoTenants;
const CATEGORIES = ["VERIFICARE_INSTALATIE_FISA", "CONTRACT_VERIFICARE_INSTALATIE"];

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  for (const code of CATEGORIES) {
    await prisma.templateCategory.upsert({ where: { code }, update: {}, create: { code, name: code } });
    await prisma.documentTemplate.deleteMany({ where: { tenantId: null, name: `Test ${code}` } });
    await prisma.documentTemplate.create({ data: { tenantId: null, categoryCode: code, name: `Test ${code}`, content: "<p>x</p>" } });
  }
});
afterAll(async () => {
  for (const code of CATEGORIES) await prisma.documentTemplate.deleteMany({ where: { tenantId: null, name: `Test ${code}` } });
  await closeStub();
  await prisma.$disconnect();
});

const finalizeWithEmail = () =>
  revisions.createDirect(
    app,
    f.a.id,
    createDirectRevisionSchema.parse({
      type: "verificare_instalatie",
      clientId: f.a.clientId,
      clientAddressId: f.a.addressId,
      employeeId: f.a.employeeId,
      date: "2026-10-15T08:00:00.000Z",
      report: {
        outcome: "raport_complet",
        installationData: { distributorName: "Distrigaz Sud Rețele", codTehnicPOD: "POD-MAIL", clientAddressId: f.a.addressId },
        reportData: { reportKind: "verificare_instalatie", decizie: "admis", nextDate: "15.10.2028", clientSignature: { clientEmail: "client@fixture.test", gdprConsent: false } },
      },
    }),
    null,
  );

describe("documentele vizitei ajung la client după înregistrarea la OS", () => {
  it("la finalizare nu se trimite nimic clientului (niciun document cu sendToEmail)", async () => {
    const appt = await finalizeWithEmail();
    const docs = await prisma.document.findMany({ where: { appointmentId: appt.id } });
    expect(docs.length).toBe(2);
    for (const d of docs) expect((d.contextJson as Record<string, unknown>).sendToEmail).toBeUndefined();
  });

  it("e-mailul de înregistrare atașează restul setului (contractul), fără fișa regenerată", async () => {
    const appt = await finalizeWithEmail();
    const docs = await prisma.document.findMany({ where: { appointmentId: appt.id }, include: { template: { select: { categoryCode: true } } } });
    for (const d of docs) await prisma.document.update({ where: { id: d.id }, data: { status: "COMPLETED", s3Key: `${f.a.id}/x/${d.id}.pdf` } });
    const fisa = docs.find((d) => d.template?.categoryCode === "VERIFICARE_INSTALATIE_FISA")!;
    const extra = await osRegistrationAttachments(prisma, f.a.id, appt.id, fisa.id);
    expect(extra.map((d) => d.id)).toEqual(docs.filter((d) => d.id !== fisa.id).map((d) => d.id));
    // Altă firmă: nimic.
    expect(await osRegistrationAttachments(prisma, f.b.id, appt.id, fisa.id)).toEqual([]);
  });
});
