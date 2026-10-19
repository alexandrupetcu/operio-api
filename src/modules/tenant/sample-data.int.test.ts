import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedRegistrySeries, seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { buildAnexa6Workbook } from "../anre-reports/anre-reports.service.js";
import { SAMPLE_CLIENT, createSampleData, deleteSampleData } from "./sample-data.js";
import { getReadiness, invalidateReadiness } from "./readiness.js";
import { readSampleSettings } from "./sample-settings.js";

let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  invalidateReadiness(f.a.id);
  invalidateReadiness(f.b.id);
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const year = new Date().getFullYear();

/** O vizită reală (nu de exemplu), finalizată, care TREBUIE să apară în Anexa 6. */
async function realCompletedVisit(tenantId: string, clientId: string, addressId: string) {
  return prisma.appointment.create({
    data: {
      tenantId,
      clientId,
      clientAddressId: addressId,
      type: "revizie_instalatie",
      title: "Revizie reală",
      date: new Date(year, 5, 15, 10, 0, 0),
      status: "completed",
      completedAt: new Date(year, 5, 15, 11, 0, 0),
    },
  });
}

describe("datele de exemplu — creare", () => {
  it("creează clientul de exemplu, instalația și o vizită finalizată", async () => {
    const res = await createSampleData(app, f.a.id);
    expect(res.clientId).toBeTruthy();
    expect(res.appointmentId).toBeTruthy();

    const client = await prisma.client.findUniqueOrThrow({
      where: { id: res.clientId },
      include: { addresses: true, gasInstallations: true },
    });
    expect(client.tenantId).toBe(f.a.id);
    expect(client.firstName).toBe(SAMPLE_CLIENT.firstName);
    expect(client.lastName).toBe(SAMPLE_CLIENT.lastName);
    expect(client.addresses.length).toBe(1);
    expect(client.gasInstallations.length).toBe(1);

    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: res.appointmentId! } });
    expect(appt.type).toBe("revizie_instalatie");
    expect(appt.status).toBe("completed");
    expect(appt.completedAt).not.toBeNull();
  });

  it("e idempotentă: a doua chemare nu creează un al doilea client de exemplu", async () => {
    const first = await createSampleData(app, f.a.id);
    const second = await createSampleData(app, f.a.id);
    expect(second.clientId).toBe(first.clientId);
    expect(second.documentsQueued).toBe(false);
    expect(await prisma.client.count({ where: { tenantId: f.a.id, lastName: SAMPLE_CLIENT.lastName } })).toBe(1);
  });

  it("referința se scrie în Tenant.settingsJson.sample", async () => {
    const res = await createSampleData(app, f.a.id);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: f.a.id } });
    const sample = readSampleSettings(tenant.settingsJson);
    expect(sample).not.toBeNull();
    expect(sample!.clientId).toBe(res.clientId);
    expect(sample!.appointmentId).toBe(res.appointmentId);
    // Nu atinge setările existente ale firmei.
    expect((tenant.settingsJson as { company?: { name?: string } }).company?.name).toBe("Firma A SRL");
  });

  it("datele de exemplu ale firmei A nu apar la firma B", async () => {
    await createSampleData(app, f.a.id);
    expect(await prisma.client.count({ where: { tenantId: f.b.id, lastName: SAMPLE_CLIENT.lastName } })).toBe(0);
    const tenantB = await prisma.tenant.findUniqueOrThrow({ where: { id: f.b.id } });
    expect(readSampleSettings(tenantB.settingsJson)).toBeNull();
  });
});

describe("readiness — sample.present", () => {
  it("fără date de exemplu → sample.present false", async () => {
    const r = await getReadiness(app, f.a.id);
    expect(r.sample).toEqual({ present: false });
  });

  it("după creare → sample.present true, cu clientId și appointmentId", async () => {
    const res = await createSampleData(app, f.a.id);
    const r = await getReadiness(app, f.a.id);
    expect(r.sample.present).toBe(true);
    expect(r.sample.clientId).toBe(res.clientId);
    expect(r.sample.appointmentId).toBe(res.appointmentId);
  });

  it("vizita de exemplu NU bifează „prima vizită finalizată”", async () => {
    await createSampleData(app, f.a.id);
    invalidateReadiness(f.a.id);
    const r = await getReadiness(app, f.a.id);
    expect(r.items.find((i) => i.key === "visit")!.done).toBe(false);
  });

  it("o vizită reală finalizată bifează punctul, chiar cu exemplul prezent", async () => {
    await createSampleData(app, f.a.id);
    await realCompletedVisit(f.a.id, f.a.clientId, f.a.addressId);
    invalidateReadiness(f.a.id);
    const r = await getReadiness(app, f.a.id);
    expect(r.items.find((i) => i.key === "visit")!.done).toBe(true);
  });

  it("clientul de exemplu NU bifează „primul client”", async () => {
    // Firma B are deja un client din fixtură — îl ștergem ca să testăm curat.
    await prisma.appointment.deleteMany({ where: { tenantId: f.b.id } });
    await prisma.client.deleteMany({ where: { tenantId: f.b.id } });
    invalidateReadiness(f.b.id);
    expect((await getReadiness(app, f.b.id)).items.find((i) => i.key === "client")!.done).toBe(false);

    await createSampleData(app, f.b.id);
    invalidateReadiness(f.b.id);
    expect((await getReadiness(app, f.b.id)).items.find((i) => i.key === "client")!.done).toBe(false);
  });

  it("după ștergere → sample.present redevine false", async () => {
    await createSampleData(app, f.a.id);
    await deleteSampleData(app, f.a.id, f.a.admin.id);
    const r = await getReadiness(app, f.a.id);
    expect(r.sample).toEqual({ present: false });
  });
});

describe("Anexa 6 exclude vizita de exemplu", () => {
  it("doar vizita reală intră în registru", async () => {
    await realCompletedVisit(f.a.id, f.a.clientId, f.a.addressId);
    const before = await buildAnexa6Workbook(app, f.a.id, year);
    expect(before.rows).toBe(1);

    await createSampleData(app, f.a.id);
    const after = await buildAnexa6Workbook(app, f.a.id, year);
    expect(after.rows).toBe(1); // exemplul nu a adăugat niciun rând
  });

  it("fără vizite reale, registrul e gol deși exemplul există", async () => {
    await createSampleData(app, f.a.id);
    const wb = await buildAnexa6Workbook(app, f.a.id, year);
    expect(wb.rows).toBe(0);
    expect(wb.filename).toContain(`Anexa6-${year}`);
    expect(wb.buffer.byteLength).toBeGreaterThan(0);
  });

  it("registrul firmei A nu conține vizitele firmei B", async () => {
    await realCompletedVisit(f.b.id, f.b.clientId, f.b.addressId);
    expect((await buildAnexa6Workbook(app, f.a.id, year)).rows).toBe(0);
    expect((await buildAnexa6Workbook(app, f.b.id, year)).rows).toBe(1);
  });
});

describe("datele de exemplu — ștergere", () => {
  it("șterge clientul, adresa, instalația și programarea", async () => {
    const created = await createSampleData(app, f.a.id);
    const res = await deleteSampleData(app, f.a.id, f.a.admin.id);

    expect(res.deleted).toBe(true);
    expect(res.clientId).toBe(created.clientId);
    expect(res.appointments).toBeGreaterThanOrEqual(1);
    expect(await prisma.client.count({ where: { id: created.clientId } })).toBe(0);
    expect(await prisma.appointment.count({ where: { id: created.appointmentId! } })).toBe(0);
    expect(await prisma.gasInstallation.count({ where: { clientId: created.clientId } })).toBe(0);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: f.a.id } });
    expect(readSampleSettings(tenant.settingsJson)).toBeNull();
  });

  it("intrările de registratură ale exemplului se ANULEAZĂ, nu se șterg", async () => {
    const created = await createSampleData(app, f.a.id);
    const series = await seedRegistrySeries(f.a.id);
    const entry = await prisma.registryEntry.create({
      data: {
        tenantId: f.a.id,
        seriesId: series.id,
        number: 1,
        year,
        displayNumber: `OUT-1/${year}`,
        subject: "Fișă de exemplu",
        clientId: created.clientId,
        createdById: f.a.admin.id,
      },
    });

    const res = await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(res.registryEntriesVoided).toBe(1);

    const row = await prisma.registryEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row.status).toBe("voided");
    expect(row.voidedAt).not.toBeNull();
    expect(row.voidedById).toBe(f.a.admin.id);
    expect(row.voidReason).toBe("Date de exemplu șterse");
    // Numărul alocat rămâne vizibil (urmă de audit).
    expect(row.number).toBe(1);
    expect(row.displayNumber).toBe(`OUT-1/${year}`);
  });

  it("fără date de exemplu → `deleted: false`, fără excepție", async () => {
    const res = await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(res).toEqual({
      deleted: false,
      clientId: null,
      appointments: 0,
      documents: 0,
      registryEntriesVoided: 0,
    });
  });

  it("un proiect legat de clientul de exemplu blochează ștergerea (409)", async () => {
    const created = await createSampleData(app, f.a.id);
    const projectType = await prisma.projectType.create({
      data: { tenantId: f.a.id, name: "Tip test", code: `test-${Date.now()}` },
    });
    await prisma.project.create({
      data: {
        tenantId: f.a.id,
        clientId: created.clientId,
        projectTypeId: projectType.id,
        name: "Proiect pe clientul de exemplu",
        address: "Str. Exemplu nr. 1",
        city: "București",
        county: "București",
      },
    });

    const err = await expectReject(() => deleteSampleData(app, f.a.id, f.a.admin.id));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/are proiecte asociate/);
    expect(await prisma.client.count({ where: { id: created.clientId } })).toBe(1);
  });

  it("ștergerea nu atinge clienții reali ai firmei", async () => {
    await createSampleData(app, f.a.id);
    await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(await prisma.client.count({ where: { id: f.a.clientId } })).toBe(1);
    expect(await prisma.appointment.count({ where: { id: f.a.appointmentId } })).toBe(1);
  });
});
