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
import * as stamps from "./stamps.service.js";
import { sendCertificationExpiryNotifications, listExpiringAuthorizations } from "./certification-alerts.js";
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
  it("un om poate avea mai multe certificări, cu datele lor", async () => {
    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ expiresAt: "2026-08-09" }));
    await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_pgd", number: "211180011" }));

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
    expect((await expectReject(() => certs.updateCertification(app, f.a.id, f.b.employeeId, theirs.id, {}))).status).toBe(404);
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

  it("ștampila de instalator care include EGIU + PGD ajunge pe documentele semnate cu EGIU", async () => {
    const egiu = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_egiu" }));
    const pgd = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_pgd" }));
    const s = await stamps.createStamp(app, f.a.id, f.a.employeeId, { name: "Ștampilă instalator", authority: "ANRE", certIds: [egiu.id, pgd.id] }, null);
    const withImage = await stamps.setStampImage(app, f.a.id, f.a.employeeId, s.id, Buffer.from("png"), null);
    const r = await resolveSignatory(prisma, f.a.id, "instalator", { technicianEmployeeId: f.a.employeeId });
    expect([r?.certType, r?.stampS3Key]).toEqual(["anre_egiu", withImage.s3Key]);
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

describe("autorizațiile firmei (ANRE / ISCIR) care expiră", () => {
  const NOW = new Date(2026, 9, 19, 7, 0);
  const setCompany = (company: Record<string, string>, iscirNumber = "89C-689") =>
    prisma.tenant.update({ where: { id: f.a.id }, data: { iscirNumber, settingsJson: { company } } });

  it("expirată → în listă și notificată doar biroului; o dată per prag", async () => {
    await setCompany({ anreNr: "19833", anreTip: "EDIB", anreExp: "08.12.2025", iscirExp: "15.10.2027" });
    const list = await listExpiringAuthorizations(prisma, f.a.id, 60, NOW);
    expect(list.map((a) => [a.key, a.daysLeft < 0])).toEqual([["anre", true]]);

    expect(await sendCertificationExpiryNotifications(prisma, f.a.id, NOW)).toBe(1); // doar adminul (operatorul nu)
    expect(await sendCertificationExpiryNotifications(prisma, f.a.id, new Date(2026, 9, 20, 7, 0))).toBe(0);
    const [n] = await prisma.notification.findMany({ where: { userId: f.a.admin.id, dedupeKey: { startsWith: "due:auth:anre" } } });
    expect(n.subject).toBe("Autorizația ANRE a firmei a expirat");
  });

  it("ISCIR în fereastră (în 30 de zile); date nevalide sau goale → ignorate", async () => {
    await setCompany({ anreExp: "nelimitat", iscirExp: "18.11.2026" });
    const list = await listExpiringAuthorizations(prisma, f.a.id, 60, NOW);
    expect(list.map((a) => [a.key, a.daysLeft])).toEqual([["iscir", 30]]);
  });

  it("altă firmă nu primește alertele lui A", async () => {
    await setCompany({ anreExp: "08.12.2025" });
    expect(await listExpiringAuthorizations(prisma, f.b.id, 60, NOW)).toEqual([]);
  });
});

describe("ștampilele unui angajat (o ștampilă include 1..n certificări)", () => {
  const actor = () => f.a.admin.id;

  it("o certificare se mută de pe o ștampilă pe alta; cea veche o pierde", async () => {
    const rvt = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "iscir_rvt" }));
    const one = await stamps.createStamp(app, f.a.id, f.a.employeeId, { name: "ISCIR 1", authority: "ISCIR", certIds: [rvt.id] }, actor());
    const two = await stamps.createStamp(app, f.a.id, f.a.employeeId, { name: "ISCIR 2", authority: "ISCIR" }, actor());
    await stamps.updateStamp(app, f.a.id, f.a.employeeId, two.id, { certIds: [rvt.id] }, actor());

    const list = await stamps.listStamps(app, f.a.id, f.a.employeeId);
    expect(list.find((s) => s.id === one.id)!.certifications).toEqual([]);
    expect(list.find((s) => s.id === two.id)!.certifications.map((c) => c.id)).toEqual([rvt.id]);
  });

  it("certificările altei autorități nu pot sta pe ștampilă (400)", async () => {
    const egiu = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "anre_egiu" }));
    const err = await expectReject(() =>
      stamps.createStamp(app, f.a.id, f.a.employeeId, { name: "ISCIR", authority: "ISCIR", certIds: [egiu.id] }, actor()),
    );
    expect(err.status).toBe(400);
    const s = await stamps.createStamp(app, f.a.id, f.a.employeeId, { name: "ISCIR", authority: "ISCIR" }, actor());
    expect((await expectReject(() => certs.updateCertification(app, f.a.id, f.a.employeeId, egiu.id, { stampId: s.id }))).status).toBe(400);
  });

  it("„Ștampilă nouă” din formularul certificării creează una a autorității ei", async () => {
    const c = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "iscir_rsl", stampId: "new" }));
    expect(c.stamp?.name).toBe("Ștampilă ISCIR");
    const [s] = await stamps.listStamps(app, f.a.id, f.a.employeeId);
    expect([s.authority, s.certifications.map((x) => x.id)]).toEqual(["ISCIR", [c.id]]);
  });

  it("ștergerea ștampilei lasă certificările fără ștampilă; schimbarea tipului în altă autoritate o desprinde", async () => {
    const rvt = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "iscir_rvt", stampId: "new" }));
    await stamps.deleteStamp(app, f.a.id, f.a.employeeId, rvt.stamp!.id, actor());
    expect((await prisma.employeeCertification.findUnique({ where: { id: rvt.id } }))!.stampId).toBeNull();

    const rsl = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "iscir_rsl", stampId: "new" }));
    const changed = await certs.updateCertification(app, f.a.id, f.a.employeeId, rsl.id, { type: "anre_egiu" });
    expect(changed.stampId).toBeNull();
  });

  it("ștampila altei firme → 404; nimic urcat", async () => {
    const theirs = await stamps.createStamp(app, f.b.id, f.b.employeeId, { name: "B", authority: "ANRE" }, null);
    expect((await expectReject(() => stamps.setStampImage(app, f.a.id, f.b.employeeId, theirs.id, Buffer.from("x"), actor()))).status).toBe(404);
    expect((await expectReject(() => stamps.deleteStamp(app, f.a.id, f.a.employeeId, theirs.id, actor()))).status).toBe(404);
    expect(s3.uploaded).toHaveLength(0);
  });

  it("jurnalul angajatului înregistrează certificările și ștampilele, cu autorul", async () => {
    const c = await certs.createCertification(app, f.a.id, f.a.employeeId, input({ type: "iscir_rvt" }), actor());
    const s = await stamps.createStamp(app, f.a.id, f.a.employeeId, { name: "ISCIR", authority: "ISCIR", certIds: [c.id] }, actor());
    await stamps.setStampImage(app, f.a.id, f.a.employeeId, s.id, Buffer.from("png"), actor());
    const log = await prisma.auditLog.findMany({
      where: { tenantId: f.a.id, entityType: "employee", entityId: f.a.employeeId },
      orderBy: { createdAt: "asc" },
    });
    expect(log.map((l) => l.action)).toEqual(["certification.created", "stamp.created", "stamp.image_set"]);
    expect(log.every((l) => l.actorUserId === f.a.admin.id)).toBe(true);
  });
});
