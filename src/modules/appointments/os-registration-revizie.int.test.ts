import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { enqueuedJobs } from "../../test/setup-int.js";

vi.mock("../../lib/email.js", () => ({ sendNotificationEmail: vi.fn(async () => {}) }));

import { listPendingOsRegistrations, setOsRegistration, setOsSubmission } from "./os-registration.js";

/**
 * Revizia de centrală (ISCIR) se înregistrează și ea la distribuitor: după finalizare
 * apare la „de înregistrat”, primește numărul OS, iar raportul ISCIR se regenerează
 * (cu numărul tipărit) și pleacă la client.
 */
let app: FastifyInstance;
let f: TwoTenants;
let apptId: string;
let revisionId: string;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  enqueuedJobs.length = 0;
  await prisma.templateCategory.upsert({ where: { code: "REVIZIE_CENTRALA" }, update: {}, create: { code: "REVIZIE_CENTRALA", name: "Revizie centrală" } });
  await prisma.documentTemplate.deleteMany({ where: { tenantId: null, name: "Test ISCIR revizie" } });
  await prisma.documentTemplate.create({ data: { tenantId: null, categoryCode: "REVIZIE_CENTRALA", name: "Test ISCIR revizie", content: "<p>{{os_nr_inregistrare}}</p>" } });
  const rev = await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: new Date(2026, 9, 20) } });
  revisionId = rev.id;
  const appt = await prisma.appointment.create({
    data: {
      tenantId: f.a.id,
      clientId: f.a.clientId,
      clientAddressId: f.a.addressId,
      equipmentId: f.a.equipmentId,
      equipmentRevisionId: rev.id,
      type: "revizie",
      title: "Revizie centrală",
      date: new Date(2026, 9, 20, 10),
      duration: 60,
      status: "completed",
      completedAt: new Date(2026, 9, 20, 11),
    },
  });
  apptId = appt.id;
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("înregistrarea la OS — revizie centrală", () => {
  it("revizia finalizată apare la „de înregistrat”", async () => {
    const pending = await listPendingOsRegistrations(prisma, f.a.id, 5);
    expect(pending.map((p) => p.id)).toContain(apptId);
  });

  it("numărul OS se salvează, raportul ISCIR se regenerează și pleacă la client", async () => {
    await prisma.client.update({ where: { id: f.a.clientId }, data: { email: "client.a@fixture.test" } });
    const res = await setOsRegistration(app, f.a.id, apptId, { number: "OS-123", registeredAt: new Date(2026, 9, 21).toISOString() });
    expect(res.osRegistrationNumber).toBe("OS-123");
    expect("regenerationQueued" in res && res.regenerationQueued).toBe(true);

    const job = enqueuedJobs.find((j) => (j.data as { revisionId?: string }).revisionId === revisionId);
    expect(job).toBeTruthy();
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: (job!.data as { documentId: string }).documentId } });
    expect(doc.contextJson).toMatchObject({ appointmentId: apptId, osRegistrationNotify: true });

    expect((await listPendingOsRegistrations(prisma, f.a.id, 5)).map((p) => p.id)).not.toContain(apptId);
  });
});

describe("înregistrarea la OS — revizie centrală, fără e-mail", () => {
  it("se regenerează raportul, dar nu se trimite nimic", async () => {
    const res = await setOsRegistration(app, f.a.id, apptId, { number: "OS-9" });
    expect("willNotify" in res && res.willNotify).toBe(false);
    const job = enqueuedJobs.find((j) => (j.data as { revisionId?: string }).revisionId === revisionId);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: (job!.data as { documentId: string }).documentId } });
    expect(doc.contextJson).toMatchObject({ osRegistrationNotify: false });
  });
});

describe("depunerea la OS (așteaptă numărul)", () => {
  it("marcată depusă → rămâne în listă, cu data depunerii; numărul o scoate din listă", async () => {
    const sub = await setOsSubmission(app, f.a.id, apptId, { submittedAt: new Date(2026, 9, 21).toISOString() });
    expect(sub.osSubmittedAt).toBeTruthy();
    const pending = await listPendingOsRegistrations(prisma, f.a.id, 5);
    expect(pending.find((p) => p.id === apptId)?.osSubmittedAt).toBeTruthy();

    await setOsRegistration(app, f.a.id, apptId, { number: "OS-1" });
    expect((await listPendingOsRegistrations(prisma, f.a.id, 5)).map((p) => p.id)).not.toContain(apptId);
  });

  it("numărul fără depunere marcată → se consideră și depusă", async () => {
    await setOsRegistration(app, f.a.id, apptId, { number: "OS-2", registeredAt: new Date(2026, 9, 22).toISOString() });
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: apptId } });
    expect(a.osSubmittedAt).toEqual(new Date(2026, 9, 22));
  });

  it("anularea depunerii (marcată din greșeală); nu se poate după ce are număr", async () => {
    await setOsSubmission(app, f.a.id, apptId, { submittedAt: new Date().toISOString() });
    const undone = await setOsSubmission(app, f.a.id, apptId, { submittedAt: null });
    expect(undone.osSubmittedAt).toBeNull();
    await setOsRegistration(app, f.a.id, apptId, { number: "OS-3" });
    const err = await expectReject(() => setOsSubmission(app, f.a.id, apptId, { submittedAt: null }));
    expect(err.status).toBe(400);
  });

  it("programarea altei firme → 404", async () => {
    const err = await expectReject(() => setOsSubmission(app, f.b.id, apptId, { submittedAt: new Date().toISOString() }));
    expect(err.status).toBe(404);
  });
});
