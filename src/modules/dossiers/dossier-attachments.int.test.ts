import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";

const stored = new Map<string, Buffer>();
vi.mock("../../lib/s3.js", () => ({
  uploadFile: vi.fn(async (key: string, buf: Buffer) => void stored.set(key, buf)),
  deleteFile: vi.fn(async (key: string) => void stored.delete(key)),
}));

import * as attachments from "./dossier-attachments.js";

/** Pagina Dosare → facturi / certificate / avize atașate, citite automat, descărcabile oricând. */
let app: FastifyInstance;
let f: TwoTenants;
let dossierId: string;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  stored.clear();
  const pt = await prisma.projectType.findFirstOrThrow({ where: { tenantId: f.a.id } }).catch(() =>
    prisma.projectType.create({ data: { tenantId: f.a.id, code: "bransament", name: "Branșament" } }),
  );
  const d = await prisma.project.create({ data: { tenantId: f.a.id, clientId: f.a.clientId, projectTypeId: pt.id, name: "Dosar test", address: "Str. X 1", city: "Y", county: "Z", kind: "quick_dossier" } });
  dossierId = d.id;
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const pdf = { buffer: Buffer.from("%PDF-1.4 test"), filename: "certificat teava.pdf", mimetype: "application/pdf" };
const reader = vi.fn(async () => ({ tip: "certificat_calitate" as const, furnizor: "TEHNOWORLD", certificat: { nr: "25399134", data: "24.07.2025" }, materiale: [] }));

describe("atașamentele dosarului", () => {
  it("încărcarea păstrează fișierul pe dosar, cu ținta și tipul; citirea întoarce ce a găsit", async () => {
    const r = await attachments.upload(app, f.a.id, f.a.admin.id, dossierId, { target: "teava", kind: "certificat_calitate", read: true }, pdf, reader);
    expect(r.extracted).toMatchObject({ furnizor: "TEHNOWORLD", certificat: { nr: "25399134" } });
    expect(stored.size).toBe(1);
    const list = await attachments.list(app, f.a.id, dossierId);
    expect(list).toEqual([expect.objectContaining({ id: r.attachment.id, name: "certificat teava.pdf", target: "teava", kind: "certificat_calitate" })]);
  });

  it("fără citire, sau când citirea pică, fișierul rămâne atașat", async () => {
    const r1 = await attachments.upload(app, f.a.id, f.a.admin.id, dossierId, { target: "avize", kind: "aviz", read: false }, pdf, reader);
    expect(r1.extracted).toBeNull();
    const failing = vi.fn(async () => { throw new Error("model indisponibil"); });
    const r2 = await attachments.upload(app, f.a.id, f.a.admin.id, dossierId, { target: "materiale", kind: "factura", read: true }, pdf, failing);
    expect(r2.extracted).toBeNull();
    expect(r2.readError).toMatch(/model indisponibil/);
    expect(await attachments.list(app, f.a.id, dossierId)).toHaveLength(2);
  });

  it("ștergerea scoate fișierul; dosarul altei firme → 404", async () => {
    const r = await attachments.upload(app, f.a.id, f.a.admin.id, dossierId, { target: "teava", kind: "factura", read: false }, pdf, reader);
    expect((await expectReject(() => attachments.list(app, f.b.id, dossierId))).status).toBe(404);
    expect((await expectReject(() => attachments.remove(app, f.b.id, dossierId, r.attachment.id))).status).toBe(404);
    await attachments.remove(app, f.a.id, dossierId, r.attachment.id);
    expect(await attachments.list(app, f.a.id, dossierId)).toEqual([]);
    expect(stored.size).toBe(0);
  });

  it("tipurile de fișier: PDF și poze; altceva → 400", async () => {
    const err = await expectReject(() => attachments.upload(app, f.a.id, f.a.admin.id, dossierId, { target: "teava", kind: "factura", read: false }, { ...pdf, filename: "x.exe", mimetype: "application/octet-stream" }, reader));
    expect(err.status).toBe(400);
  });
});
