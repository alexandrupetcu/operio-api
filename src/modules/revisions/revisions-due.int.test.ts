import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { dueRevisions } from "./revisions-due.js";
import { getAlertWindows } from "../tenant/alert-settings.js";

/** Revizii → „Scadente”: centralele și instalațiile cu revizia / verificarea următoare aproape, neprogramate. */
let app: FastifyInstance;
let f: TwoTenants;
const day = 86_400_000;
const roDate = (d: Date) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  // Programarea „revizie” din fixture ar exclude centrala (e deja programată) — o anulăm.
  await prisma.appointment.updateMany({ where: { tenantId: { in: [f.a.id, f.b.id] } }, data: { status: "cancelled" } });
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("scadențele reviziilor", () => {
  it("centrala cu revizia expirând în fereastră + instalația cu verificarea următoare aproape; nu cele departe sau ale altei firme", async () => {
    const { revisionIntervalYears } = await getAlertWindows(prisma, f.a.id);
    const last = new Date(Date.now() + 10 * day);
    last.setFullYear(last.getFullYear() - revisionIntervalYears);
    await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: last } });
    await prisma.equipmentRevision.create({ data: { equipmentId: f.b.equipmentId, revisionDate: last } });

    const visit = (installationId: string, nextIn: number, tenant = f.a) =>
      prisma.appointment.create({
        data: {
          tenantId: tenant.id, clientId: tenant.clientId, installationId, type: "verificare_instalatie", title: "Verificare",
          date: new Date(Date.now() - 700 * day), duration: 60, status: "completed", completedAt: new Date(Date.now() - 700 * day),
          completionOutcome: "raport_complet", completionDataJson: { reportKind: "verificare_instalatie", decizie: "admis", nextDate: roDate(new Date(Date.now() + nextIn * day)) },
        },
      });
    await visit(f.a.installationId, 20);
    const far = await prisma.gasInstallation.create({ data: { clientId: f.a.clientId, label: "Departe" } });
    await visit(far.id, 200);
    await visit(f.b.installationId, 20, f.b);

    const due = await dueRevisions(app, f.a.id, 60);
    expect(due.map((d) => d.kind).sort()).toEqual(["centrala", "instalatie"]);
    const c = due.find((d) => d.kind === "centrala")!;
    expect(c).toMatchObject({ clientId: f.a.clientId, equipmentId: f.a.equipmentId, type: "revizie" });
    expect(c.days).toBeGreaterThanOrEqual(9);
    const i = due.find((d) => d.kind === "instalatie")!;
    expect(i).toMatchObject({ installationId: f.a.installationId, type: "verificare_instalatie" });
    expect(due[0].days).toBeLessThanOrEqual(due[1].days); // cele mai apropiate întâi
  });

  it("o instalație deja programată nu mai apare", async () => {
    await prisma.appointment.create({
      data: {
        tenantId: f.a.id, clientId: f.a.clientId, installationId: f.a.installationId, type: "verificare_instalatie", title: "V",
        date: new Date(Date.now() - 700 * day), duration: 60, status: "completed", completedAt: new Date(Date.now() - 700 * day),
        completionOutcome: "raport_complet", completionDataJson: { nextDate: roDate(new Date(Date.now() + 5 * day)) },
      },
    });
    await prisma.appointment.create({
      data: { tenantId: f.a.id, clientId: f.a.clientId, installationId: f.a.installationId, type: "verificare_instalatie", title: "V2", date: new Date(Date.now() + 3 * day), duration: 60 },
    });
    expect((await dueRevisions(app, f.a.id, 60)).filter((d) => d.kind === "instalatie")).toEqual([]);
  });
});
