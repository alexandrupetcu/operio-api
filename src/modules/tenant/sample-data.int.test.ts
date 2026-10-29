import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedRegistrySeries, seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { enqueuedJobs } from "../../test/setup-int.js";
import { buildAnexa6Workbook } from "../anre-reports/anre-reports.service.js";
import { CERT_TYPE_CODES } from "../../lib/certifications.js";
import { invalidateEntitlements } from "../../lib/entitlements/resolve.js";
import {
  SAMPLE_CLIENT,
  SAMPLE_DOSSIER_GROUP_NAME,
  SAMPLE_DOSSIER_NAME,
  SAMPLE_EMPLOYEE_PREFIX,
  createSampleData,
  deleteSampleData,
} from "./sample-data.js";
import { getReadiness, invalidateReadiness } from "./readiness.js";
import { readSampleSettings } from "./sample-settings.js";
import { readSignatories, resolveSignatory } from "./signatories.js";

// S3 în memorie: semnăturile și ștampilele generate se „încarcă” aici; ștergerile se rețin.
const s3 = vi.hoisted(() => ({ files: new Map<string, Buffer>(), deleted: [] as string[] }));
vi.mock("../../lib/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/s3.js")>()),
  uploadFile: async (key: string, body: Buffer) => {
    s3.files.set(key, Buffer.from(body));
    return key;
  },
  deleteFile: async (key: string) => {
    s3.deleted.push(key);
    s3.files.delete(key);
  },
  getFileBuffer: async (key: string) => {
    const b = s3.files.get(key);
    if (!b) throw new Error(`no file ${key}`);
    return b;
  },
  getPresignedUrl: async (key: string) => `https://s3.test/${key}`,
}));

let app: FastifyInstance;
let f: TwoTenants;
let groupId: string;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  invalidateReadiness(f.a.id);
  invalidateReadiness(f.b.id);
  s3.files.clear();
  s3.deleted.length = 0;
  enqueuedJobs.length = 0;

  // Grupul de sistem al dosarului de exemplu (fără firmă — nu cade la resetDb).
  await prisma.templateCategory.upsert({
    where: { code: "CARTE_BRANSAMENT" },
    update: {},
    create: { code: "CARTE_BRANSAMENT", name: "Carte branșament" },
  });
  await prisma.documentTemplate.deleteMany({ where: { tenantId: null, name: { in: [SAMPLE_DOSSIER_GROUP_NAME, "Exemplu test PV"] } } });
  const group = await prisma.documentTemplate.create({
    data: { tenantId: null, categoryCode: "CARTE_BRANSAMENT", name: SAMPLE_DOSSIER_GROUP_NAME, type: "group", distributorCode: "DISTRIGAZ" },
  });
  groupId = group.id;
  await prisma.documentTemplate.create({
    data: { tenantId: null, categoryCode: "CARTE_BRANSAMENT", name: "Exemplu test PV", type: "single", s3Key: null, parentGroupId: groupId, memberOrder: 1 },
  });
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

/** Simulează worker-ul: documentele în coadă devin generate (altfel ștergerea dă 409). */
async function finishGeneration(tenantId: string) {
  await prisma.document.updateMany({ where: { tenantId, status: { in: ["PENDING", "GENERATING"] } }, data: { status: "COMPLETED" } });
}

async function sampleOf(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return { sample: readSampleSettings(tenant.settingsJson)!, signatories: readSignatories(tenant.settingsJson), settings: tenant.settingsJson };
}

describe("datele de exemplu — creare", () => {
  it("creează clientul de exemplu, instalația și o vizită finalizată", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
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
    const first = await createSampleData(app, f.a.id, f.a.admin.id);
    const second = await createSampleData(app, f.a.id, f.a.admin.id);
    expect(second.clientId).toBe(first.clientId);
    expect(second.documentsQueued).toBe(false);
    expect(await prisma.client.count({ where: { tenantId: f.a.id, lastName: SAMPLE_CLIENT.lastName } })).toBe(1);
  });

  it("referința se scrie în Tenant.settingsJson.sample", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: f.a.id } });
    const sample = readSampleSettings(tenant.settingsJson);
    expect(sample).not.toBeNull();
    expect(sample!.clientId).toBe(res.clientId);
    expect(sample!.appointmentId).toBe(res.appointmentId);
    // Nu atinge setările existente ale firmei.
    expect((tenant.settingsJson as { company?: { name?: string } }).company?.name).toBe("Firma A SRL");
  });

  it("datele de exemplu ale firmei A nu apar la firma B", async () => {
    await createSampleData(app, f.a.id, f.a.admin.id);
    expect(await prisma.client.count({ where: { tenantId: f.b.id, lastName: SAMPLE_CLIENT.lastName } })).toBe(0);
    const tenantB = await prisma.tenant.findUniqueOrThrow({ where: { id: f.b.id } });
    expect(readSampleSettings(tenantB.settingsJson)).toBeNull();
  });
});

describe("datele de exemplu — echipa", () => {
  it("creează trei angajați „Exemplu — …” cu funcții, certificări, semnătură și ștampilă", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    expect(res.employeeIds.length).toBe(3);

    const employees = await prisma.employee.findMany({
      where: { id: { in: res.employeeIds } },
      include: { certifications: true, stamps: { include: { certifications: true } } },
    });
    expect(employees.length).toBe(3);
    for (const e of employees) {
      expect(e.tenantId).toBe(f.a.id);
      expect(e.firstName.startsWith(SAMPLE_EMPLOYEE_PREFIX)).toBe(true);
      expect(e.employeeType).toBe("intern");
      expect(e.isActive).toBe(true);
      expect(e.positions.length).toBeGreaterThan(0);
      expect(e.position).toBe(e.positions[0]);
      expect(e.phone).toMatch(/^070000000\d$/);
      expect(e.userId).toBeNull(); // fără cont → nu ocupă un loc de tehnician

      // Certificări doar din catalog, marcate ca exemplu, valabile.
      expect(e.certifications.length).toBeGreaterThan(0);
      for (const c of e.certifications) {
        expect(CERT_TYPE_CODES).toContain(c.type);
        expect(c.number).toMatch(/^EX-/);
        expect(c.expiresAt!.getTime()).toBeGreaterThan(Date.now());
        expect(c.issuedAt!.getTime()).toBeLessThan(Date.now());
        expect(c.stampId).not.toBeNull(); // fiecare certificare stă pe o ștampilă
      }

      // Semnătura și ștampila: PNG-uri încărcate în S3, pe cheile firmei.
      expect(e.signatureS3Key).toMatch(new RegExp(`^${f.a.id}/employees/${e.id}/signature\\.png$`));
      expect(s3.files.get(e.signatureS3Key!)!.subarray(1, 4).toString()).toBe("PNG");
      expect(e.stamps.length).toBeGreaterThan(0);
      for (const st of e.stamps) {
        expect(st.s3Key).toMatch(new RegExp(`^${f.a.id}/employees/${e.id}/stamp-`));
        expect(s3.files.get(st.s3Key!)!.subarray(1, 4).toString()).toBe("PNG");
        expect(st.certifications.length).toBeGreaterThan(0);
      }
    }

    const types = employees.flatMap((e) => e.certifications.map((c) => c.type));
    for (const t of ["anre_egiu", "iscir_rvt", "iscir_rsl", "rte"]) expect(types).toContain(t);
    const positions = employees.flatMap((e) => e.positions);
    for (const p of ["instalator", "rte", "sef_santier"]) expect(positions).toContain(p);
  });

  it("programarea de exemplu e a instalatorului de exemplu, nu a primului angajat al firmei", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: res.appointmentId! } });
    expect(appt.employeeId).not.toBe(f.a.employeeId);
    expect(res.employeeIds).toContain(appt.employeeId);
    const installer = await prisma.employee.findUniqueOrThrow({ where: { id: appt.employeeId! }, include: { certifications: true } });
    expect(installer.positions[0]).toBe("instalator");
    expect(installer.certifications.some((c) => c.type === "anre_egiu")).toBe(true);
  });

  it("semnatarii impliciți se setează pe rolurile goale și se rețin în settingsJson.sample", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    const { sample, signatories } = await sampleOf(f.a.id);
    expect(sample.employeeIds).toEqual(res.employeeIds);
    expect([...sample.signatoryRolesSet].sort()).toEqual(["instalator", "rsl", "rvt"]);
    for (const role of ["instalator", "rvt", "rsl"] as const) expect(res.employeeIds).toContain(signatories[role]);
  });

  it("nu suprascrie semnatarul ales deja de firmă", async () => {
    await prisma.employeeCertification.create({
      data: { tenantId: f.a.id, employeeId: f.a.employeeId, type: "anre_egiu", number: "123" },
    });
    await prisma.tenant.update({
      where: { id: f.a.id },
      data: { settingsJson: { company: { name: "Firma A SRL" }, signatories: { instalator: f.a.employeeId } } },
    });
    await createSampleData(app, f.a.id, f.a.admin.id);
    const { sample, signatories } = await sampleOf(f.a.id);
    expect(signatories.instalator).toBe(f.a.employeeId);
    expect([...sample.signatoryRolesSet].sort()).toEqual(["rsl", "rvt"]);
  });

  it("un semnatar implicit de exemplu nu trece înaintea tehnicianului real al vizitei", async () => {
    await createSampleData(app, f.a.id, f.a.admin.id);
    await prisma.employeeCertification.create({
      data: { tenantId: f.a.id, employeeId: f.a.employeeId, type: "anre_egiu", number: "REAL-1" },
    });
    // Vizită reală, făcută de tehnicianul firmei: semnează el, nu „Exemplu — …”.
    const real = await resolveSignatory(prisma, f.a.id, "instalator", { technicianEmployeeId: f.a.employeeId });
    expect(real?.employeeId).toBe(f.a.employeeId);
    // Nimeni real calificat: rămâne exemplul (ștampila „EXEMPLU” arată că lipsește cineva).
    const none = await resolveSignatory(prisma, f.a.id, "rvt", { technicianEmployeeId: f.a.employeeId });
    expect(none?.name.startsWith(SAMPLE_EMPLOYEE_PREFIX)).toBe(true);
  });

  it("a doua chemare nu dublează echipa sau dosarul", async () => {
    const first = await createSampleData(app, f.a.id, f.a.admin.id);
    const second = await createSampleData(app, f.a.id, f.a.admin.id);
    expect(second.employeeIds).toEqual(first.employeeIds);
    expect(second.dossierId).toBe(first.dossierId);
    expect(await prisma.employee.count({ where: { tenantId: f.a.id, firstName: { startsWith: SAMPLE_EMPLOYEE_PREFIX } } })).toBe(3);
    expect(await prisma.project.count({ where: { tenantId: f.a.id, kind: "quick_dossier" } })).toBe(1);
  });
});

describe("datele de exemplu — dosarul", () => {
  it("creează dosarul de branșament pe clientul de exemplu, cu echipa și generarea în coadă", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    expect(res.dossierId).toBeTruthy();
    const d = await prisma.project.findUniqueOrThrow({
      where: { id: res.dossierId! },
      include: { teamMembers: true, documents: { include: { document: true } } },
    });
    expect(d.tenantId).toBe(f.a.id);
    expect(d.kind).toBe("quick_dossier");
    expect(d.name).toBe(SAMPLE_DOSSIER_NAME);
    expect(d.clientId).toBe(res.clientId);
    expect(d.templateGroupId).toBe(groupId);
    expect(d.address).toContain("Str. Exemplu nr. 1");
    const meta = d.metadata as Record<string, string>;
    expect(meta.cod_atr).toBeTruthy();
    expect(meta.proiect_nr).toBeTruthy();

    const roles = Object.fromEntries(d.teamMembers.map((t) => [t.role, t.employeeId]));
    for (const role of ["instalator", "rte", "sef_santier", "proiectant"]) expect(res.employeeIds).toContain(roles[role]);

    expect(d.documents.length).toBe(1);
    expect(d.documents[0].document.templateId).toBe(groupId);
    expect(enqueuedJobs.some((j) => j.queue === "document-generation" && (j.data as { projectId?: string }).projectId === d.id)).toBe(true);
    expect((await sampleOf(f.a.id)).sample.dossierId).toBe(d.id);

    invalidateReadiness(f.a.id);
    expect((await getReadiness(app, f.a.id)).sample.dossierId).toBe(d.id);
  });

  it("fără grupul de sistem, exemplul se creează fără dosar", async () => {
    await prisma.documentTemplate.updateMany({ where: { id: groupId }, data: { isActive: false } });
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    expect(res.dossierId).toBeNull();
    expect(res.employeeIds.length).toBe(3);
    expect(await prisma.project.count({ where: { tenantId: f.a.id } })).toBe(0);
  });
});

describe("datele de exemplu — dosarul (abonament)", () => {
  it("abonamentul fără Dosare → exemplul se creează fără dosar", async () => {
    await prisma.tenant.update({ where: { id: f.b.id }, data: { plan: "field" } });
    invalidateEntitlements(f.b.id);
    const res = await createSampleData(app, f.b.id, f.b.admin.id);
    expect(res.dossierId).toBeNull();
    expect(await prisma.project.count({ where: { tenantId: f.b.id } })).toBe(0);
  });
});

describe("readiness — sample.present", () => {
  it("fără date de exemplu → sample.present false", async () => {
    const r = await getReadiness(app, f.a.id);
    expect(r.sample).toEqual({ present: false });
  });

  it("după creare → sample.present true, cu clientId și appointmentId", async () => {
    const res = await createSampleData(app, f.a.id, f.a.admin.id);
    const r = await getReadiness(app, f.a.id);
    expect(r.sample.present).toBe(true);
    expect(r.sample.clientId).toBe(res.clientId);
    expect(r.sample.appointmentId).toBe(res.appointmentId);
  });

  it("vizita de exemplu NU bifează „prima vizită finalizată”", async () => {
    await createSampleData(app, f.a.id, f.a.admin.id);
    invalidateReadiness(f.a.id);
    const r = await getReadiness(app, f.a.id);
    expect(r.items.find((i) => i.key === "visit")!.done).toBe(false);
  });

  it("o vizită reală finalizată bifează punctul, chiar cu exemplul prezent", async () => {
    await createSampleData(app, f.a.id, f.a.admin.id);
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

    await createSampleData(app, f.b.id, f.b.admin.id);
    invalidateReadiness(f.b.id);
    expect((await getReadiness(app, f.b.id)).items.find((i) => i.key === "client")!.done).toBe(false);
  });

  it("angajații de exemplu NU bifează „primul tehnician” și nu ascund avertismentele de semnatar", async () => {
    await prisma.appointment.deleteMany({ where: { tenantId: f.b.id } });
    await prisma.employee.deleteMany({ where: { tenantId: f.b.id } });
    await createSampleData(app, f.b.id, f.b.admin.id);
    invalidateReadiness(f.b.id);
    const r = await getReadiness(app, f.b.id);
    expect(r.items.find((i) => i.key === "employee")!.done).toBe(false);
    expect(r.warnings.map((w) => w.role).sort()).toEqual(["instalator", "rsl", "rvt"]);
  });

  it("după ștergere → sample.present redevine false", async () => {
    await createSampleData(app, f.a.id, f.a.admin.id);
    await finishGeneration(f.a.id);
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

    await createSampleData(app, f.a.id, f.a.admin.id);
    const after = await buildAnexa6Workbook(app, f.a.id, year);
    expect(after.rows).toBe(1); // exemplul nu a adăugat niciun rând
  });

  it("fără vizite reale, registrul e gol deși exemplul există", async () => {
    await createSampleData(app, f.a.id, f.a.admin.id);
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
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
    await finishGeneration(f.a.id);
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
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
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

    await finishGeneration(f.a.id);
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

  it("șterge echipa de exemplu (certificări, ștampile, fișiere) și dosarul cu documentele lui", async () => {
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
    const keys = [
      ...(await prisma.employee.findMany({ where: { id: { in: created.employeeIds } }, select: { signatureS3Key: true } })).map((e) => e.signatureS3Key!),
      ...(await prisma.employeeStamp.findMany({ where: { employeeId: { in: created.employeeIds } }, select: { s3Key: true } })).map((s) => s.s3Key!),
    ];
    const dossierDocIds = (await prisma.projectDocument.findMany({ where: { projectId: created.dossierId! } })).map((d) => d.documentId);
    await finishGeneration(f.a.id);

    const res = await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(res.deleted).toBe(true);
    expect(res.employees).toBe(3);
    expect(res.dossier).toBe(true);
    expect(await prisma.employee.count({ where: { id: { in: created.employeeIds } } })).toBe(0);
    expect(await prisma.employeeCertification.count({ where: { employeeId: { in: created.employeeIds } } })).toBe(0);
    expect(await prisma.employeeStamp.count({ where: { employeeId: { in: created.employeeIds } } })).toBe(0);
    expect(await prisma.project.count({ where: { id: created.dossierId! } })).toBe(0);
    expect(await prisma.document.count({ where: { id: { in: dossierDocIds } } })).toBe(0);
    for (const k of keys) expect(s3.deleted).toContain(k);
    // Angajatul real al firmei rămâne.
    expect(await prisma.employee.count({ where: { id: f.a.employeeId } })).toBe(1);
  });

  it("documentele dosarului încă în generare → 409, nimic șters", async () => {
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
    const err = await expectReject(() => deleteSampleData(app, f.a.id, f.a.admin.id));
    expect(err.status).toBe(409);
    expect(await prisma.project.count({ where: { id: created.dossierId! } })).toBe(1);
    expect(await prisma.employee.count({ where: { id: { in: created.employeeIds } } })).toBe(3);
  });

  it("readuce doar semnatarii puși de exemplu și doar dacă încă indică angajații de exemplu", async () => {
    // Firma are deja un RSL-IP ales; exemplul pune instalator + RVT.
    await prisma.employeeCertification.create({ data: { tenantId: f.a.id, employeeId: f.a.employeeId, type: "iscir_rsl", number: "RSL-1" } });
    await prisma.employeeCertification.create({ data: { tenantId: f.a.id, employeeId: f.a.employeeId, type: "iscir_rvt", number: "RVT-1" } });
    await prisma.tenant.update({
      where: { id: f.a.id },
      data: { settingsJson: { company: { name: "Firma A SRL" }, signatories: { rsl: f.a.employeeId } } },
    });
    await createSampleData(app, f.a.id, f.a.admin.id);
    // Între timp firma își alege RVT-ul real.
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: f.a.id } });
    const settings = t.settingsJson as Record<string, unknown>;
    await prisma.tenant.update({
      where: { id: f.a.id },
      data: { settingsJson: { ...settings, signatories: { ...(settings.signatories as object), rvt: f.a.employeeId } } },
    });
    await finishGeneration(f.a.id);

    await deleteSampleData(app, f.a.id, f.a.admin.id);
    const { signatories, settings: after } = await sampleOf(f.a.id);
    expect(signatories.instalator).toBeNull(); // pus de exemplu → scos
    expect(signatories.rvt).toBe(f.a.employeeId); // schimbat de firmă → păstrat
    expect(signatories.rsl).toBe(f.a.employeeId); // al firmei de la început → neatins
    expect(readSampleSettings(after)).toBeNull();
  });

  it("merge și dacă o parte a fost ștearsă manual (un angajat, dosarul)", async () => {
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
    await finishGeneration(f.a.id);
    await prisma.project.delete({ where: { id: created.dossierId! } });
    await prisma.employee.delete({ where: { id: created.employeeIds[1] } });

    const res = await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(res.deleted).toBe(true);
    expect(res.employees).toBe(2);
    expect(res.dossier).toBe(false);
    expect(await prisma.employee.count({ where: { tenantId: f.a.id, firstName: { startsWith: SAMPLE_EMPLOYEE_PREFIX } } })).toBe(0);
    // A doua ștergere: nimic de făcut, fără excepție.
    expect((await deleteSampleData(app, f.a.id, f.a.admin.id)).deleted).toBe(false);
  });

  it("clientul de exemplu șters manual: echipa și semnatarii se curăță oricum", async () => {
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
    await finishGeneration(f.a.id);
    await prisma.project.deleteMany({ where: { clientId: created.clientId } });
    await prisma.appointment.deleteMany({ where: { clientId: created.clientId } });
    await prisma.client.delete({ where: { id: created.clientId } });

    await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(await prisma.employee.count({ where: { id: { in: created.employeeIds } } })).toBe(0);
    const { signatories, settings } = await sampleOf(f.a.id);
    expect(signatories).toEqual({ instalator: null, rvt: null, rsl: null });
    expect(readSampleSettings(settings)).toBeNull();
  });

  it("un angajat de exemplu pus în echipa unui proiect real blochează ștergerea (409)", async () => {
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
    await finishGeneration(f.a.id);
    const projectType = await prisma.projectType.findFirstOrThrow({ where: { tenantId: f.a.id, code: "bransament" } });
    const real = await prisma.project.create({
      data: { tenantId: f.a.id, clientId: f.a.clientId, projectTypeId: projectType.id, name: "Proiect real", address: "X", city: "Y", county: "Z" },
    });
    await prisma.projectTeamMember.create({ data: { projectId: real.id, role: "rte", name: "", employeeId: created.employeeIds[2] } });
    const err = await expectReject(() => deleteSampleData(app, f.a.id, f.a.admin.id));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/echipa unui proiect/);
    expect(await prisma.employee.count({ where: { id: { in: created.employeeIds } } })).toBe(3);
  });

  it("fără date de exemplu → `deleted: false`, fără excepție", async () => {
    const res = await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(res).toEqual({
      deleted: false,
      clientId: null,
      appointments: 0,
      documents: 0,
      registryEntriesVoided: 0,
      employees: 0,
      dossier: false,
    });
  });

  it("un proiect legat de clientul de exemplu blochează ștergerea (409)", async () => {
    const created = await createSampleData(app, f.a.id, f.a.admin.id);
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
    await createSampleData(app, f.a.id, f.a.admin.id);
    await finishGeneration(f.a.id);
    await deleteSampleData(app, f.a.id, f.a.admin.id);
    expect(await prisma.client.count({ where: { id: f.a.clientId } })).toBe(1);
    expect(await prisma.appointment.count({ where: { id: f.a.appointmentId } })).toBe(1);
  });
});
