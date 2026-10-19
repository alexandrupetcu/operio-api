import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as appointments from "./appointments.service.js";

let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const doc = (tenantId: string, name: string, extra: Record<string, unknown> = {}) =>
  prisma.document.create({ data: { tenantId, name, status: "COMPLETED", s3Key: `${tenantId}/${name}.pdf`, ...extra } });

describe("documentele unei programări (Calendar → programare finalizată)", () => {
  it("întoarce documentele generate pentru programare (RT/PV/FISA), nu și pe ale altor programări", async () => {
    await doc(f.a.id, "RT", { appointmentId: f.a.appointmentId });
    await doc(f.a.id, "PV", { appointmentId: f.a.appointmentId, status: "GENERATING", s3Key: null });
    await doc(f.a.id, "Alt document al firmei");

    const res = await appointments.listDocuments(app, f.a.id, f.a.appointmentId);
    expect(res.documents.map((d) => d.name)).toEqual(["RT", "PV"]);
    expect(res.documents[1].status).toBe("GENERATING");
    expect(res.awaitingAnalyzerPdf).toBe(false);
  });

  it("revizia de centrală: include fișa ISCIR legată prin revizie (creată și de worker-ul de e-mail)", async () => {
    const iscir = await doc(f.a.id, "Revizie ISCIR");
    const revision = await prisma.equipmentRevision.create({
      data: { equipmentId: f.a.equipmentId, revisionDate: new Date(), iscirDocumentId: iscir.id },
    });
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { equipmentRevisionId: revision.id } });

    const res = await appointments.listDocuments(app, f.a.id, f.a.appointmentId);
    expect(res.documents.map((d) => d.id)).toEqual([iscir.id]);
    expect(res.awaitingAnalyzerPdf).toBe(false);
  });

  it("revizie fără fișa ISCIR încă (PDF-ul analizorului n-a sosit) → awaitingAnalyzerPdf", async () => {
    const revision = await prisma.equipmentRevision.create({
      data: { equipmentId: f.a.equipmentId, revisionDate: new Date(), status: "PENDING" },
    });
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { equipmentRevisionId: revision.id } });

    const res = await appointments.listDocuments(app, f.a.id, f.a.appointmentId);
    expect(res.documents).toEqual([]);
    expect(res.awaitingAnalyzerPdf).toBe(true);
  });

  it("programarea altei firme → 404; documentele lui B nu apar în A", async () => {
    await doc(f.b.id, "RT B", { appointmentId: f.b.appointmentId });
    const err = await expectReject(() => appointments.listDocuments(app, f.a.id, f.b.appointmentId));
    expect(err.status).toBe(404);
  });

  it("tehnicianul vede documentele doar pe programările lui (aceeași vizibilitate ca în calendar)", async () => {
    await doc(f.a.id, "RT", { appointmentId: f.a.appointmentId });
    const own = await appointments.listDocuments(app, f.a.id, f.a.appointmentId, { kind: "own", employeeId: f.a.employeeId });
    expect(own.documents).toHaveLength(1);

    const other = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Alt", lastName: "Tehnician" } });
    const err = await expectReject(() =>
      appointments.listDocuments(app, f.a.id, f.a.appointmentId, { kind: "own", employeeId: other.id }),
    );
    expect(err.status).toBe(404);
  });

  it("o programare ștearsă (arhivată) → 404", async () => {
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { deletedAt: new Date() } });
    const err = await expectReject(() => appointments.listDocuments(app, f.a.id, f.a.appointmentId));
    expect(err.status).toBe(404);
  });
});
