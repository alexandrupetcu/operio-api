import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as revisionService from "./equipment-revisions.service.js";
import * as clientsService from "../clients/clients.service.js";

/**
 * Tabul „Revizii” din fișa clientului: toate reviziile de echipamente ale clientului
 * (pe toate centralele) și vizitele pe instalații, cu starea înregistrării la OS.
 */
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

describe("reviziile unui client — echipamente", () => {
  it("adună reviziile de pe toate echipamentele clientului, cu echipamentul și vizita", async () => {
    const second = await prisma.equipment.create({
      data: { clientId: f.a.clientId, clientAddressId: f.a.addressId, type: "CENTRALA", name: "A doua centrală", serial: "SER-2" },
    });
    const r1 = await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: new Date(2026, 8, 1) } });
    const r2 = await prisma.equipmentRevision.create({ data: { equipmentId: second.id, revisionDate: new Date(2026, 9, 1) } });
    await prisma.appointment.update({
      where: { id: f.a.appointmentId },
      data: { equipmentRevisionId: r1.id, status: "completed", completedAt: new Date(2026, 8, 1, 11), osRegistrationNumber: "OS-77" },
    });

    const rows = await revisionService.listByClient(app, f.a.id, f.a.clientId);
    expect(rows.map((r) => r.id)).toEqual([r2.id, r1.id]); // cea mai nouă prima
    expect(rows[0].equipment).toMatchObject({ id: second.id, name: "A doua centrală", serial: "SER-2" });
    expect(rows[1].appointment).toMatchObject({ id: f.a.appointmentId, osRegistrationNumber: "OS-77" });
  });

  it("nu amestecă reviziile altui client și refuză clientul altei firme", async () => {
    await prisma.equipmentRevision.create({ data: { equipmentId: f.b.equipmentId, revisionDate: new Date(2026, 9, 1) } });
    expect(await revisionService.listByClient(app, f.a.id, f.a.clientId)).toEqual([]);
    const err = await expectReject(() => revisionService.listByClient(app, f.a.id, f.b.clientId));
    expect(err.status).toBe(404);
  });
});

describe("reviziile unui client — instalații", () => {
  it("vizitele pe instalație din fișa clientului au finalizarea și câmpurile OS", async () => {
    await prisma.appointment.create({
      data: {
        tenantId: f.a.id,
        clientId: f.a.clientId,
        clientAddressId: f.a.addressId,
        installationId: f.a.installationId,
        type: "verificare_instalatie",
        title: "Verificare",
        date: new Date(2026, 9, 10, 9),
        duration: 60,
        status: "completed",
        completedAt: new Date(2026, 9, 10, 10),
        osSubmittedAt: new Date(2026, 9, 11),
        osRegistrationNumber: "OS-12",
        osRegisteredAt: new Date(2026, 9, 12),
      },
    });
    const client = await clientsService.getById(app, f.a.id, f.a.clientId);
    const visit = client.gasInstallations[0].appointments[0] as Record<string, unknown>;
    expect(visit.completedAt).toBeInstanceOf(Date);
    expect(visit.osSubmittedAt).toBeInstanceOf(Date);
    expect(visit.osRegistrationNumber).toBe("OS-12");
    expect(visit.osRegisteredAt).toBeInstanceOf(Date);
  });
});

describe("reviziile unui client — decizia raportului", () => {
  it("decizia din raportul vizitei (conclusions.decision) vine pe `appointment.decision`, fără tot raportul", async () => {
    const rev = await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: new Date(2026, 9, 5) } });
    await prisma.appointment.update({
      where: { id: f.a.appointmentId },
      data: {
        equipmentRevisionId: rev.id,
        status: "completed",
        completedAt: new Date(2026, 9, 5, 10),
        completionDataJson: { conclusions: { decision: "respins", nextRevisionDate: "2028-10-05" }, functionalVerifications: { grounding: "DA" } },
      },
    });
    const rows = await revisionService.listByClient(app, f.a.id, f.a.clientId);
    const row = rows.find((r) => r.id === rev.id)!;
    expect(row.appointment?.decision).toBe("respins");
    expect((row.appointment as Record<string, unknown>).completionDataJson).toBeUndefined();
  });

  it("vizită fără raport sau cu altă structură → decision null", async () => {
    const rev = await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: new Date(2026, 9, 6) } });
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { equipmentRevisionId: rev.id, completionDataJson: { outcome: "revenire" } } });
    const rows = await revisionService.listByClient(app, f.a.id, f.a.clientId);
    expect(rows.find((r) => r.id === rev.id)!.appointment?.decision).toBeNull();
  });
});
