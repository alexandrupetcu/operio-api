import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";

const s3 = vi.hoisted(() => ({ uploaded: [] as string[], deleted: [] as string[] }));
vi.mock("../../lib/s3.js", () => ({
  uploadFile: async (key: string) => void s3.uploaded.push(key),
  deleteFile: async (key: string) => void s3.deleted.push(key),
  getPresignedUrl: async (key: string) => `https://s3.test/${key}`,
}));
vi.mock("../../lib/image.js", () => ({ removeWhiteBackground: async (b: Buffer) => b }));
vi.mock("../../lib/email.js", () => ({ sendNotificationEmail: vi.fn(async () => {}) }));
vi.mock("../../lib/web-push.js", () => ({ sendWebPush: vi.fn(async () => ({ ok: true })), isWebPushConfigured: () => false }));
vi.mock("../../lib/expo-push.js", () => ({ sendExpoPush: vi.fn(async () => ({ ok: [], invalid: [] })), isValidExpoToken: () => true }));

import * as certs from "./certifications.service.js";
import { sendCertificationExpiryNotifications } from "./certification-alerts.js";
import { getSignatories, resolveSignatory, setSignatories } from "../tenant/signatories.js";

let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  s3.uploaded.length = 0;
  s3.deleted.length = 0;
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const input = (over: Record<string, unknown>) => certs.certificationInputSchema.parse({ type: "anre_egiu", number: "408160011", ...over });
const person = (tenantId: string, firstName: string, over: Record<string, unknown> = {}) =>
  prisma.employee.create({ data: { tenantId, firstName, lastName: "Test", ...over } });

describe("certificările unui angajat", () => {
  it("un om poate avea mai multe certificări; ștampila se pune pe una și primește cheie în folderul firmei", async () => {
    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ expiresAt: "2026-08-09" }));
    const pgd = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_pgd", number: "211180011" }));
    const withStamp = await certs.setCertificationStamp(app, f.a.id, f.a.employeeId, pgd.id, Buffer.from("png"));
    expect(withStamp.stampS3Key).toMatch(new RegExp(`^${f.a.id}/employees/${f.a.employeeId}/cert-`));

    const list = await certs.listCertifications(app, f.a.id, f.a.employeeId);
    expect(list.map((c) => c.type)).toEqual(["anre_egiu", "anre_pgd"]);
    expect(list[0].expiresAt?.toISOString().slice(0, 10)).toBe("2026-08-09");
  });

  it("„Altă certificare” cere un nume", async () => {
    expect(() => input({ type: "other" })).toThrow(/Dă un nume/);
    const c = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "other", label: "Electrician ANRE gr. IIA" }));
    expect(c.displayName).toBe("Electrician ANRE gr. IIA");
  });

  it("angajatul sau certificarea altei firme → 404, fără să atingă nimic", async () => {
    expect((await expectReject(() => certs.createCertification(app, f.a.id, f.b.employeeId, input({})))).status).toBe(404);
    const theirs = await certs.createCertification(app, f.b.id, f.b.employeeId, input({}));
    expect((await expectReject(() => certs.deleteCertification(app, f.a.id, f.b.employeeId, theirs.id))).status).toBe(404);
    expect((await expectReject(() => certs.setCertificationStamp(app, f.a.id, f.a.employeeId, theirs.id, Buffer.from("x")))).status).toBe(404);
    expect(await prisma.employeeCertification.count({ where: { id: theirs.id } })).toBe(1);
    expect(s3.uploaded).toHaveLength(0);
  });
});

describe("semnatari impliciți (instalator / RVT / RSL-IP)", () => {
  it("doar cineva cu certificarea rolului poate fi ales; alegerea se salvează pe firmă", async () => {
    const rvt = await person(f.a.id, "Vasile", { employeeType: "colaborator" });
    await certs.createCertification(app, f.a.id, rvt.id, input({ type: "iscir_rvt", number: "13841" }));

    const err = await expectReject(() => setSignatories(app, f.a.id, { rvt: f.a.employeeId }));
    expect(err.status).toBe(400);

    const res = await setSignatories(app, f.a.id, { rvt: rvt.id });
    const role = res.roles.find((r) => r.key === "rvt")!;
    expect(role.employeeId).toBe(rvt.id);
    expect(role.valid).toBe(true);
    expect(role.candidates.map((c) => c.name)).toEqual(["Vasile Test"]);
  });

  it("nu se poate alege un angajat al altei firme", async () => {
    await certs.createCertification(app, f.b.id, f.b.employeeId, input({ type: "iscir_rvt" }));
    expect((await expectReject(() => setSignatories(app, f.a.id, { rvt: f.b.employeeId }))).status).toBe(400);
  });

  it("ordinea: ales în raport → implicit → tehnicianul vizitei; fiecare doar dacă are certificarea", async () => {
    const tech = f.a.employeeId;
    const colab = await person(f.a.id, "Colaborator");
    const other = await person(f.a.id, "Altcineva");
    await certs.createCertification(app, f.a.id, tech, input({ type: "iscir_rvt", number: "T-1" }));
    await certs.createCertification(app, f.a.id, colab.id, input({ type: "iscir_rvt", number: "C-1" }));

    // Fără implicit: tehnicianul.
    expect((await resolveSignatory(prisma, f.a.id, "rvt", { technicianEmployeeId: tech }))?.source).toBe("technician");

    await setSignatories(app, f.a.id, { rvt: colab.id });
    const byDefault = await resolveSignatory(prisma, f.a.id, "rvt", { technicianEmployeeId: tech });
    expect([byDefault?.source, byDefault?.number]).toEqual(["default", "C-1"]);

    // Ales în raport, dar fără atestat RVT → se trece mai departe, la implicit.
    expect((await resolveSignatory(prisma, f.a.id, "rvt", { overrideEmployeeId: other.id }))?.source).toBe("default");
    expect((await resolveSignatory(prisma, f.a.id, "rvt", { overrideEmployeeId: tech }))?.number).toBe("T-1");
  });

  it("implicitul dezactivat între timp apare ca problemă și nu mai semnează", async () => {
    const rvt = await person(f.a.id, "Plecat");
    await certs.createCertification(app, f.a.id, rvt.id, input({ type: "iscir_rvt" }));
    await setSignatories(app, f.a.id, { rvt: rvt.id });
    await prisma.employee.update({ where: { id: rvt.id }, data: { isActive: false } });

    const role = (await getSignatories(prisma, f.a.id)).roles.find((r) => r.key === "rvt")!;
    expect(role.valid).toBe(false);
    expect(await resolveSignatory(prisma, f.a.id, "rvt")).toBeNull();
  });

  it("ștampila de instalator pusă pe PGD ajunge pe documentele semnate cu EGIU", async () => {
    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_egiu" }));
    const pgd = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_pgd" }));
    const stamped = await certs.setCertificationStamp(app, f.a.id, f.a.employeeId, pgd.id, Buffer.from("png"));
    const r = await resolveSignatory(prisma, f.a.id, "instalator", { technicianEmployeeId: f.a.employeeId });
    expect([r?.certType, r?.stampS3Key]).toEqual(["anre_egiu", stamped.stampS3Key]);
  });
});

describe("notificări de expirare a certificărilor", () => {
  const NOW = new Date(2026, 9, 19, 7, 0);
  const notifs = (userId: string) => prisma.notification.findMany({ where: { userId, dedupeKey: { startsWith: "due:cert:" } } });

  it("o dată per prag, nu zilnic; către birou și persoana în cauză (dacă are cont)", async () => {
    // Operatorul fixturii e legat de angajatul fixturii.
    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ expiresAt: "2026-11-30" })); // 42 de zile
    const first = await sendCertificationExpiryNotifications(prisma, f.a.id, NOW);
    expect(first).toBe(2); // admin + operatorul (persoana)
    expect(await sendCertificationExpiryNotifications(prisma, f.a.id, new Date(2026, 9, 20, 7, 0))).toBe(0);

    // Intră în pragul de 30 de zile → încă o notificare.
    expect(await sendCertificationExpiryNotifications(prisma, f.a.id, new Date(2026, 9, 31, 7, 0))).toBe(2);
    const [n] = await notifs(f.a.admin.id);
    expect(n.subject).toMatch(/EGIU expiră în \d+ zile/);
  });

  it("peste fereastra firmei, la angajați inactivi sau cu comutatorul oprit → nimic", async () => {
    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ expiresAt: "2027-06-01" }));
    const gone = await person(f.a.id, "Inactiv", { isActive: false });
    await certs.createCertification(app, f.a.id, gone.id, input({ expiresAt: "2026-10-20" }));
    expect(await sendCertificationExpiryNotifications(prisma, f.a.id, NOW)).toBe(0);

    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ expiresAt: "2026-10-25" }));
    await prisma.tenant.update({ where: { id: f.a.id }, data: { settingsJson: { notifications: { certification_expiry: false } } } });
    expect(await sendCertificationExpiryNotifications(prisma, f.a.id, NOW)).toBe(0);
  });
});
